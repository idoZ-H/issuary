import type { GitHubClient } from "../lib/github";
import type { RetrievedChunk } from "../types";
import { MAX_TICKET_CLARIFICATIONS } from "../types";

export interface ToolCall { name: string; input: any }
export interface ToolResult { is_error: boolean; content: string; pause_for_clarification?: boolean }

// Retrieval grounding observed across a ticket's github_search_code calls. Lets
// the handler tell how well the model could ground its answer — the documented
// failure mode (github code search empty + only weak semantic matches) is
// exactly github_total_matches===0 with a low top_semantic_score.
export interface GroundingStats {
  github_search_calls: number;
  github_total_matches: number;
  semantic_calls: number;
  top_semantic_score: number | null;
}

// Calibrated relevance floor below which the best reranked semantic match is
// treated as "no confident grounding". The reranker (bge-reranker-base) emits a
// [0,1] relevance score, so unlike the raw bi-encoder cosine band this is a
// meaningful threshold. Tunable from production observation.
export const LOW_GROUNDING_SCORE = 0.3;

// True when the model tried to ground its answer in code but came up empty:
// github code search returned nothing AND the best semantic match was weak or
// absent. This is the documented failure signature (private-repo code search is
// unreliable, and the bi-encoder can miss). Returns false when the model never
// searched — grounding isn't expected for every message (e.g. chitchat).
export function isLowGrounding(g: GroundingStats): boolean {
  if (g.github_search_calls === 0) return false;
  if (g.github_total_matches > 0) return false;
  return g.top_semantic_score === null || g.top_semantic_score < LOW_GROUNDING_SCORE;
}

const MAX_TOOL_CALLS = 4;
// MAX_TICKET_CLARIFICATIONS (the per-ticket ceiling) is defined in ../types so
// the dispatcher and the classifier prompt share one source of truth. Re-exported
// here for callers that import it from the dispatcher. The per-run loop pauses
// after a single ask, so within one run at most one is sent; the cap spans the
// multi-turn conversation via priorQuestionsAsked.
export { MAX_TICKET_CLARIFICATIONS };

export class ToolDispatcher {
  private toolCallCount = 0;
  private clarificationCount = 0;
  private grounding: GroundingStats = {
    github_search_calls: 0,
    github_total_matches: 0,
    semantic_calls: 0,
    top_semantic_score: null,
  };

  // Snapshot of retrieval grounding accumulated so far this ticket.
  getGrounding(): GroundingStats {
    return { ...this.grounding };
  }

  constructor(
    private readonly gh: GitHubClient,
    private readonly repo: string,
    private readonly sendClarifyingQuestion: (q: string, reason: string) => Promise<void>,
    // Phase-1 shadow hook: when provided, github_search_code also fires this with
    // the same query so semantic retrieval can be compared against GitHub code
    // search without changing the tool surface the model sees. Fire-and-forget;
    // failures here must never affect the live tool result.
    private readonly shadowRetrieve?: (query: string) => void,
    // When provided (shadow-mode clients with a built index), github_search_code
    // also returns semantic, content-based matches from the vector index. These
    // are reliable even when GitHub's code-search index is empty on private
    // repos. Returns [] when the index is still warming or has no match.
    private readonly retrieveActive?: (query: string) => Promise<RetrievedChunk[]>,
    // Clarifying questions already asked on PRIOR turns of this ticket (from the
    // pending-state counter). Combined with this run's clarificationCount to
    // enforce MAX_TICKET_CLARIFICATIONS across turns. Defaults to 0 (fresh ticket).
    private readonly priorQuestionsAsked: number = 0
  ) {}

  async dispatch(call: ToolCall): Promise<ToolResult> {
    if (call.name === "ask_clarifying_question") {
      const totalAsked = this.priorQuestionsAsked + this.clarificationCount;
      // Per-run cap (loop pauses after one) OR ticket-level ceiling across turns.
      if (this.clarificationCount >= 1 || totalAsked >= MAX_TICKET_CLARIFICATIONS) {
        return {
          is_error: true,
          content:
            `Clarification budget exhausted (max ${MAX_TICKET_CLARIFICATIONS} per ticket). Produce a final classification now; place any remaining client-only decision under a '## ⚠️ Needs client decision' section in the body, not under developer questions.`,
        };
      }
      this.clarificationCount++;
      try {
        await this.sendClarifyingQuestion(call.input.question_he, call.input.reason_en ?? "");
      } catch (e) {
        return { is_error: true, content: `Failed to deliver clarifying question: ${(e as Error).message}` };
      }
      return {
        is_error: false,
        content: JSON.stringify({ status: "question_sent", session_state: "pending_clarification" }),
        pause_for_clarification: true,
      };
    }

    if (this.toolCallCount >= MAX_TOOL_CALLS) {
      return { is_error: true, content: "Tool call budget exhausted (4 max). Produce final classification with the information you have." };
    }
    this.toolCallCount++;

    try {
      switch (call.name) {
        case "github_search_code": {
          const r = await this.gh.searchCode(this.repo, call.input.query);
          // HyDE: the model supplies a natural-language hypothesis (semantic_query)
          // for the embedding search, which embeds meaning far better than the
          // keyword `query`. Fall back to query when absent (defensive).
          const semanticQuery: string = call.input.semantic_query || call.input.query;
          if (this.shadowRetrieve) {
            try { this.shadowRetrieve(semanticQuery); } catch { /* best-effort */ }
          }
          let semantic: RetrievedChunk[] = [];
          if (this.retrieveActive) {
            try { semantic = await this.retrieveActive(semanticQuery); } catch (e) { console.warn("semantic_retrieve_failed", { repo: this.repo, error: (e as Error).message }); /* best-effort: fall back to github result only */ }
          }
          this.grounding.github_search_calls++;
          this.grounding.github_total_matches += r.total ?? r.matches?.length ?? 0;
          if (semantic.length > 0) {
            this.grounding.semantic_calls++;
            const best = Math.max(...semantic.map((c) => c.score));
            this.grounding.top_semantic_score = this.grounding.top_semantic_score === null
              ? best
              : Math.max(this.grounding.top_semantic_score, best);
          }
          const content = semantic.length > 0
            ? JSON.stringify({ github_search: r, semantic_matches: semantic })
            : JSON.stringify(r);
          return { is_error: false, content };
        }
        case "github_search_issues": {
          const r = await this.gh.searchIssues(this.repo, call.input.query, call.input.state);
          return { is_error: false, content: JSON.stringify(r) };
        }
        case "github_read_file": {
          const r = await this.gh.readFile(this.repo, call.input.path);
          return { is_error: false, content: JSON.stringify(r) };
        }
        default:
          return { is_error: true, content: `Unknown tool: ${call.name}` };
      }
    } catch (e) {
      return { is_error: true, content: `Tool ${call.name} error: ${(e as Error).message}` };
    }
  }
}

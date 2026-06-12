import type { GitHubClient } from "../lib/github";
import type { RetrievedChunk } from "../types";

export interface ToolCall { name: string; input: any }
export interface ToolResult { is_error: boolean; content: string; pause_for_clarification?: boolean }

const MAX_TOOL_CALLS = 4;
const MAX_CLARIFICATIONS = 1;

export class ToolDispatcher {
  private toolCallCount = 0;
  private clarificationCount = 0;

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
    private readonly retrieveActive?: (query: string) => Promise<RetrievedChunk[]>
  ) {}

  async dispatch(call: ToolCall): Promise<ToolResult> {
    if (call.name === "ask_clarifying_question") {
      if (this.clarificationCount >= MAX_CLARIFICATIONS) {
        return { is_error: true, content: "Clarification budget exhausted — already asked once. Produce a final classification with needs-triage label." };
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
          if (this.shadowRetrieve) {
            try { this.shadowRetrieve(call.input.query); } catch { /* best-effort */ }
          }
          let semantic: RetrievedChunk[] = [];
          if (this.retrieveActive) {
            try { semantic = await this.retrieveActive(call.input.query); } catch (e) { console.warn("semantic_retrieve_failed", { repo: this.repo, error: (e as Error).message }); /* best-effort: fall back to github result only */ }
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

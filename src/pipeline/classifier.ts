import type { ClaudeClient } from "../lib/ai";
import { getLangSmithClient } from "../lib/ai";
import type { ToolDispatcher } from "../tools/dispatch";
import type { ClassifierOutput } from "../types";
import type Anthropic from "@anthropic-ai/sdk";
import { traceable } from "langsmith/traceable";

const MAX_TURNS = 6;

export type ClassifierResult =
  | { kind: "final"; output: ClassifierOutput; usage: { input_tokens: number; output_tokens: number } }
  | { kind: "clarify"; question_he: string }
  | { kind: "error"; message: string };

export interface RunArgs {
  claude: ClaudeClient;
  dispatcher: ToolDispatcher;
  systemBlocks: Anthropic.TextBlockParam[];
  userText: string;
  tools: Anthropic.Tool[];
}

// Remove cache_control from every block in the conversation so far. Used to
// keep exactly one rolling message breakpoint as the loop appends turns —
// the Messages API caps cache breakpoints at 4 per request (system uses one).
function clearMessageCacheBreakpoints(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        delete (block as { cache_control?: unknown }).cache_control;
      }
    }
  }
}

async function runClassifierImpl(args: RunArgs): Promise<ClassifierResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: [{ type: "text", text: args.userText }] },
  ];
  const lastUsage = { input_tokens: 0, output_tokens: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await args.claude.classify({
      system: args.systemBlocks,
      userTurns: messages,
      tools: args.tools,
    });
    lastUsage.input_tokens += reply.usage.input_tokens;
    lastUsage.output_tokens += reply.usage.output_tokens;

    if (reply.stop_reason === "end_turn") {
      const textBlock = reply.content.find((b: any) => b.type === "text") as any;
      if (!textBlock) return { kind: "error", message: "model returned no text block" };
      // Structured outputs (output_config.format in ai.ts) guarantees an
      // end_turn response is valid, schema-conformant JSON — so there's no
      // parse-retry turn anymore. This try/catch now only guards the post-parse
      // non-empty checks (and a defensively-handled malformed end_turn). The
      // other failure modes — truncation and refusal — never reach here: they
      // arrive as stop_reason "max_tokens"/"refusal" and are handled by the
      // unexpected-stop_reason branch below, not as a wasted second API call.
      try {
        const parsed = parseClassifierOutput(textBlock.text);
        return { kind: "final", output: parsed, usage: lastUsage };
      } catch (e) {
        return { kind: "error", message: `classifier output invalid: ${(e as Error).message}` };
      }
    }

    if (reply.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: reply.content });
      const toolUseBlocks = reply.content.filter((b: any) => b.type === "tool_use") as any[];
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolUseBlocks) {
        const result = await args.dispatcher.dispatch({ name: tu.name, input: tu.input });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: result.content,
          is_error: result.is_error,
        });
        if (result.pause_for_clarification) {
          const question = tu.input?.question_he ?? "";
          return { kind: "clarify", question_he: question };
        }
      }

      // Rolling cache breakpoint on the conversation tail. The system+tools
      // prefix is already cached (one breakpoint in buildClassifierSystem); this
      // adds a SECOND, moving breakpoint on the latest tool_result so that the
      // NEXT turn re-reads the whole conversation prefix (prior tool_use blocks
      // + tool_results — code-search hits, semantic matches, file contents) at
      // ~0.1x instead of full price. Tool results are the bulk of per-turn
      // input on a multi-call ticket, so this is where the spend is.
      //
      // We strip any prior message breakpoint first: the cap is 4 per request
      // (system holds 1), and a single rolling breakpoint is all we need — each
      // turn's prefix subsumes the previous one. The loop adds at most one
      // assistant + one user turn per iteration, well inside the 20-block
      // cache-lookback window, so the moved breakpoint always finds the prior
      // entry.
      clearMessageCacheBreakpoints(messages);
      const lastResult = toolResults[toolResults.length - 1];
      if (lastResult) lastResult.cache_control = { type: "ephemeral" };

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    return { kind: "error", message: `unexpected stop_reason: ${reply.stop_reason}` };
  }
  return { kind: "error", message: "max turns exceeded" };
}

// Wrap the classifier loop so LangSmith captures it as a single span with the
// underlying messages.create calls and tool dispatches as nested children.
//
// We wrap LAZILY (per-process, on first call) instead of at module-load time
// because traceable's options.client is captured eagerly — and the explicit
// LangSmith client has to be created AFTER the env bridge populates
// process.env, which doesn't happen until the first fetch handler runs.
//
// processInputs scrubs the trace input payload before ingest:
// - args.claude wraps the Anthropic SDK; the SDK instance carries the API key
//   and a deeply circular reference graph.
// - args.dispatcher carries the GitHubClient (which has its installation token).
// - args.systemBlocks and tools are large but harmless; trimmed for legibility.
// We keep userText (the actual classifier input) and a small summary of the
// tool/system shapes — enough to debug from LangSmith without leaking secrets.
let _wrapped: ((args: RunArgs) => Promise<ClassifierResult>) | null = null;
export function runClassifier(args: RunArgs): Promise<ClassifierResult> {
  if (!_wrapped) {
    const client = getLangSmithClient();
    _wrapped = traceable(runClassifierImpl, {
      name: "runClassifier",
      run_type: "chain",
      ...(client ? { client } : {}),
      processInputs: (raw: any) => {
        const a = raw as RunArgs;
        return {
          userText: a.userText,
          tool_count: a.tools?.length ?? 0,
          system_block_count: a.systemBlocks?.length ?? 0,
          system_preview: a.systemBlocks?.[0]?.text?.slice(0, 200) ?? null,
        };
      },
    }) as (args: RunArgs) => Promise<ClassifierResult>;
  }
  return _wrapped(args);
}

// Structured outputs (CLASSIFIER_OUTPUT_SCHEMA in ai.ts) guarantees a
// schema-conformant object: correct enums, all required fields, no code fences.
// What it can't express is "non-empty string" (JSON schema has no minLength),
// so the only checks left here are the non-empty guards on the fields that
// would silently break downstream if blank: client_reply_he (the Telegram ack,
// always sent) and — when an issue is being filed — title_en / body_he.
// JSON.parse itself still throws on a truncated response (stop_reason
// "max_tokens"); the caller catches that and returns kind=error.
function parseClassifierOutput(text: string): ClassifierOutput {
  const parsed = JSON.parse(text) as ClassifierOutput;
  if (!parsed.client_reply_he) {
    throw new Error("missing or empty client_reply_he");
  }
  if (parsed.should_create_issue) {
    if (!parsed.title_en) throw new Error("missing or empty title_en for issue");
    if (!parsed.body_he) throw new Error("missing or empty body_he for issue");
  }
  return parsed;
}

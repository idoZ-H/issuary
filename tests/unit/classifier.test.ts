import { describe, it, expect, vi } from "vitest";
import { runClassifier } from "../../src/pipeline/classifier";

const finalJson = {
  should_create_issue: true, is_followup_to_issue: null, type: "bug" as const, severity: "high" as const,
  title_en: "T", body_he: "ב", suggested_labels: ["a"], sensitive: false, client_reply_he: "תודה",
};

function makeClaudeReply(blocks: any[], stop_reason: string) {
  return { id: "m", stop_reason, content: blocks, usage: { input_tokens: 1, output_tokens: 1 } };
}

describe("runClassifier", () => {
  it("returns the final classification when the model emits a single text block", async () => {
    const claude = {
      classify: vi.fn(async () => makeClaudeReply(
        [{ type: "text", text: JSON.stringify(finalJson) }],
        "end_turn"
      )),
    };
    const dispatcher = { dispatch: vi.fn() };
    const r = await runClassifier({
      claude: claude as any, dispatcher: dispatcher as any,
      systemBlocks: [{ type: "text", text: "s" }],
      userText: "hi", tools: [],
    });
    expect(r.kind).toBe("final");
    if (r.kind === "final") expect(r.output.title_en).toBe("T");
  });

  it("processes tool_use blocks then a final answer", async () => {
    const claude = {
      classify: vi.fn()
        .mockResolvedValueOnce(makeClaudeReply(
          [{ type: "tool_use", id: "tu1", name: "github_search_code", input: { query: "x" } }],
          "tool_use"
        ))
        .mockResolvedValueOnce(makeClaudeReply(
          [{ type: "text", text: JSON.stringify(finalJson) }],
          "end_turn"
        )),
    };
    const dispatcher = {
      dispatch: vi.fn(async () => ({ is_error: false, content: '{"matches":[]}' })),
    };
    const r = await runClassifier({
      claude: claude as any, dispatcher: dispatcher as any,
      systemBlocks: [{ type: "text", text: "s" }],
      userText: "hi", tools: [],
    });
    expect(claude.classify).toHaveBeenCalledTimes(2);
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(r.kind).toBe("final");
  });

  it("returns kind=clarify when dispatcher signals pause_for_clarification", async () => {
    const claude = {
      classify: vi.fn(async () => makeClaudeReply(
        [{ type: "tool_use", id: "tu2", name: "ask_clarifying_question", input: { question_he: "q?", reason_en: "r" } }],
        "tool_use"
      )),
    };
    const dispatcher = {
      dispatch: vi.fn(async () => ({ is_error: false, content: '{"status":"question_sent"}', pause_for_clarification: true })),
    };
    const r = await runClassifier({
      claude: claude as any, dispatcher: dispatcher as any,
      systemBlocks: [{ type: "text", text: "s" }],
      userText: "hi", tools: [],
    });
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") expect(r.question_he).toBe("q?");
  });

  it("returns kind=error on malformed JSON", async () => {
    const claude = {
      classify: vi.fn(async () => makeClaudeReply(
        [{ type: "text", text: "not json" }],
        "end_turn"
      )),
    };
    const r = await runClassifier({
      claude: claude as any, dispatcher: { dispatch: vi.fn() } as any,
      systemBlocks: [{ type: "text", text: "s" }], userText: "hi", tools: [],
    });
    expect(r.kind).toBe("error");
  });
});

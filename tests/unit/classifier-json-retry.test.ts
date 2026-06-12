import { describe, it, expect, vi } from "vitest";
import { runClassifier } from "../../src/pipeline/classifier";

// Structured outputs (output_config.format) now guarantees the model's final
// turn is valid, schema-conformant JSON, so the old "bad JSON → retry one turn
// with a stricter instruction" round-trip is gone. The only end_turn failure
// left is a truncated/refused response, which parses-fails and surfaces as
// kind=error WITHOUT a second classify call. These tests pin that no-retry
// contract — a regression that reintroduces the retry would burn a wasted API
// turn per failure.

function makeReply(text: string) {
  return { id: "m", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } };
}

describe("classifier output: no parse-retry turn", () => {
  it("returns kind=error on the first un-parseable response without a second classify call", async () => {
    const claude = { classify: vi.fn().mockResolvedValue(makeReply("truncated {\"should_create_issue\": tr")) };
    const r = await runClassifier({
      claude: claude as any, dispatcher: { dispatch: vi.fn() } as any,
      systemBlocks: [{ type: "text", text: "s" }], userText: "hi", tools: [],
    });
    expect(claude.classify).toHaveBeenCalledTimes(1);
    expect(r.kind).toBe("error");
  });
});

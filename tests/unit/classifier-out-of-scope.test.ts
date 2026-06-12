import { describe, it, expect, vi } from "vitest";
import { runClassifier } from "../../src/pipeline/classifier";

const validOutOfScope = JSON.stringify({
  should_create_issue: false,
  is_followup_to_issue: null,
  type: "out_of_scope",
  severity: "low",
  title_en: "(out of scope)",
  body_he: "(out of scope)",
  suggested_labels: [],
  sensitive: false,
  client_reply_he: "אני יכול לתעד דיווחים אבל לא לשלוח קבצים. — Ido's AI assistant",
});

function makeReply(text: string) {
  return { id: "m", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } };
}

describe("classifier out_of_scope output", () => {
  it("accepts a valid out_of_scope output", async () => {
    const claude = { classify: vi.fn().mockResolvedValueOnce(makeReply(validOutOfScope)) };
    const r = await runClassifier({
      claude: claude as any, dispatcher: { dispatch: vi.fn() } as any,
      systemBlocks: [{ type: "text", text: "s" }], userText: "show me README", tools: [],
    });
    expect(r.kind).toBe("final");
    if (r.kind === "final") {
      expect(r.output.type).toBe("out_of_scope");
      expect(r.output.should_create_issue).toBe(false);
    }
  });

  it("rejects out_of_scope with empty client_reply_he", async () => {
    const bad = JSON.stringify({
      ...JSON.parse(validOutOfScope),
      client_reply_he: "",
    });
    const claude = { classify: vi.fn().mockResolvedValue(makeReply(bad)) };
    const r = await runClassifier({
      claude: claude as any, dispatcher: { dispatch: vi.fn() } as any,
      systemBlocks: [{ type: "text", text: "s" }], userText: "show me README", tools: [],
    });
    expect(r.kind).toBe("error");
  });
});

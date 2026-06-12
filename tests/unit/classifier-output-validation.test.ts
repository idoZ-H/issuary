import { describe, it, expect, vi } from "vitest";
import { runClassifier } from "../../src/pipeline/classifier";

// With structured outputs, the API guarantees enum/type/shape conformance, so
// classifier.ts no longer hand-validates those (that's covered by the schema
// drift test in lib-ai-claude.test.ts). What the JSON schema CAN'T express is
// "non-empty string" (no minLength), so the post-parse guards below remain:
// client_reply_he must be present (the Telegram ack is always sent), and when
// an issue is being filed, title_en / body_he must be non-empty. A failed
// guard returns kind=error in a single classify call (no retry).

function makeReply(text: string) {
  return { id: "m", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } };
}

async function classify(payload: object | string) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const claude = { classify: vi.fn().mockResolvedValue(makeReply(text)) };
  const r = await runClassifier({
    claude: claude as any, dispatcher: { dispatch: vi.fn() } as any,
    systemBlocks: [{ type: "text", text: "s" }], userText: "hi", tools: [],
  });
  return { r, calls: claude.classify.mock.calls.length };
}

describe("classifier non-empty guards", () => {
  it("rejects output missing client_reply_he", async () => {
    const { r, calls } = await classify({
      should_create_issue: false, is_followup_to_issue: null,
      type: "chitchat", severity: "low",
      title_en: "(no issue)", body_he: "(no issue)",
      suggested_labels: [], sensitive: false,
      // client_reply_he missing
    });
    expect(calls).toBe(1);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/client_reply_he/);
  });

  it("rejects output with empty client_reply_he", async () => {
    const { r } = await classify({
      should_create_issue: false, is_followup_to_issue: null,
      type: "chitchat", severity: "low", title_en: "x", body_he: "x",
      suggested_labels: [], sensitive: false, client_reply_he: "",
    });
    expect(r.kind).toBe("error");
  });

  it("rejects should_create_issue=true with missing title_en", async () => {
    const { r } = await classify({
      should_create_issue: true, is_followup_to_issue: null,
      type: "bug", severity: "high", body_he: "ב",
      suggested_labels: [], sensitive: false, client_reply_he: "תודה",
      // title_en missing
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/title_en/);
  });

  it("rejects should_create_issue=true with empty body_he", async () => {
    const { r } = await classify({
      should_create_issue: true, is_followup_to_issue: null,
      type: "bug", severity: "high", title_en: "T", body_he: "",
      suggested_labels: [], sensitive: false, client_reply_he: "תודה",
    });
    expect(r.kind).toBe("error");
  });

  it("accepts a valid bug output", async () => {
    const { r } = await classify({
      should_create_issue: true, is_followup_to_issue: null,
      type: "bug", severity: "critical",
      title_en: "Login crashes", body_he: "Steps...",
      suggested_labels: ["bug"], sensitive: false, client_reply_he: "תודה",
    });
    expect(r.kind).toBe("final");
  });

  it("accepts valid chitchat output (no title/body required)", async () => {
    const { r } = await classify({
      should_create_issue: false, is_followup_to_issue: null,
      type: "chitchat", severity: "low",
      title_en: "(no issue)", body_he: "(no issue)",
      suggested_labels: [], sensitive: false, client_reply_he: "שלום",
    });
    expect(r.kind).toBe("final");
  });
});

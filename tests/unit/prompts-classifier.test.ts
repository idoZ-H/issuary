import { describe, it, expect } from "vitest";
import { buildClassifierSystem } from "../../src/prompts/classifier";

describe("buildClassifierSystem", () => {
  it("returns 2 system blocks: stable+context (cached) and per-message (uncached)", () => {
    const blocks = buildClassifierSystem({
      reporter_name: "Yossi",
      repo: "x/acme-core",
      repo_context: { tree: "src/", readme: "R", recent_issues: [], fetched_at: "t" },
      raw_message_text: "the export is broken",
      attachments_summary: "1 photo",
      pending_clarification: null,
      prior_conversation: [],
    });
    expect(blocks).toHaveLength(2);
    const cached = blocks[0]!;
    const live = blocks[1]!;
    expect(cached.cache_control).toEqual({ type: "ephemeral" });
    expect(cached.text).toContain("Ido's AI assistant");
    expect(cached.text).toContain("x/acme-core");
    expect(cached.text).toContain("src/");
    expect(live.text).toContain("Yossi");
    expect(live.text).toContain("the export is broken");
  });

  it("instructs the model to write English issue bodies and Hebrew client replies only", () => {
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y",
      repo_context: { tree: "", readme: "", recent_issues: [], fetched_at: "t" },
      raw_message_text: "x", attachments_summary: "", pending_clarification: null,
      prior_conversation: [],
    });
    const cached = blocks[0]!.text;
    expect(cached).toMatch(/body:.*ENGLISH/);
    expect(cached).toContain("client_reply_he: Hebrew");
  });

  it("provides explicit grounding rules for github_search_code citations", () => {
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y",
      repo_context: { tree: "", readme: "", recent_issues: [], fetched_at: "t" },
      raw_message_text: "x", attachments_summary: "", pending_clarification: null,
      prior_conversation: [],
    });
    expect(blocks[0]!.text).toContain("MUST cite the actual file path");
    expect(blocks[0]!.text).toContain("Do not invent file paths");
  });

  it("instructs the model to fall back to the directory listing when search returns nothing", () => {
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y",
      repo_context: { tree: "src/foo.ts\nsrc/bar.ts", readme: "", recent_issues: [], fetched_at: "t" },
      raw_message_text: "x", attachments_summary: "", pending_clarification: null,
      prior_conversation: [],
    });
    expect(blocks[0]!.text).toContain("authoritative and complete");
    expect(blocks[0]!.text).toContain("Search-miss fallback");
    expect(blocks[0]!.text).toContain("Likely files (from directory tree");
  });

  it("instructs the model to use semantic_matches when present in github_search_code results", () => {
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y",
      repo_context: { tree: "", readme: "", recent_issues: [], fetched_at: "t" },
      raw_message_text: "x", attachments_summary: "", pending_clarification: null,
      prior_conversation: [],
    });
    expect(blocks[0]!.text).toContain("semantic_matches");
  });

  it("requires asking a clarifying question for signal-light reports", () => {
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y",
      repo_context: { tree: "", readme: "", recent_issues: [], fetched_at: "t" },
      raw_message_text: "x", attachments_summary: "", pending_clarification: null,
      prior_conversation: [],
    });
    expect(blocks[0]!.text).toContain("zero concrete signal");
    expect(blocks[0]!.text).toContain("prefer ask_clarifying_question over guessing");
  });

  it("includes the prior clarifying question when present", () => {
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y",
      repo_context: { tree: "", readme: "", recent_issues: [], fetched_at: "t" },
      raw_message_text: "the dashboard one",
      attachments_summary: "",
      pending_clarification: { asked_question_he: "תוכל להבהיר?", original_message: "broken", questions_asked: 1 },
      prior_conversation: [],
    });
    expect(blocks[1]!.text).toContain("Earlier you asked");
    expect(blocks[1]!.text).toContain("the dashboard one");
    expect(blocks[1]!.text).toContain("broken");
  });

  it("answer-turn with one prior question allows a gated second question", () => {
    const live = buildClassifierSystem({
      reporter_name: "X", repo: "o/r", repo_context: { tree: "", readme: "", recent_issues: [], fetched_at: "t" },
      raw_message_text: "move it to attendance", attachments_summary: "", prior_conversation: [],
      pending_clarification: { asked_question_he: "?", original_message: "orig", questions_asked: 1 },
    })[1]!;
    expect(live.text).toMatch(/may ask exactly ONE more/i);
    expect(live.text).not.toMatch(/already asked the client the maximum/i);
  });

  it("answer-turn at the cap forbids further questions", () => {
    const live = buildClassifierSystem({
      reporter_name: "X", repo: "o/r", repo_context: { tree: "", readme: "", recent_issues: [], fetched_at: "t" },
      raw_message_text: "answer", attachments_summary: "", prior_conversation: [],
      pending_clarification: { asked_question_he: "?", original_message: "orig", questions_asked: 2 },
    })[1]!;
    expect(live.text).toMatch(/already asked the client the maximum/i);
    expect(live.text).toMatch(/Needs client decision/i);
    expect(live.text).not.toMatch(/may ask exactly ONE more/i);
  });

  it("states the 3-part client-decision gate in the preamble", () => {
    const [cached] = buildClassifierSystem({
      reporter_name: "X", repo: "o/r", repo_context: { tree: "", readme: "", recent_issues: [], fetched_at: "t" },
      raw_message_text: "x", attachments_summary: "", prior_conversation: [], pending_clarification: null,
    });
    expect(cached!.text).toMatch(/client-only/i);
    expect(cached!.text).toMatch(/no safe default/i);
    expect(cached!.text).toMatch(/at most twice|two questions/i);
    expect(cached!.text).not.toMatch(/one clarifying question per ticket/i);
  });
});

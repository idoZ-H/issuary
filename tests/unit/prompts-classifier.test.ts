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
      pending_clarification: { asked_question_he: "תוכל להבהיר?", original_message: "broken" },
      prior_conversation: [],
    });
    expect(blocks[1]!.text).toContain("Earlier you asked");
    expect(blocks[1]!.text).toContain("the dashboard one");
    expect(blocks[1]!.text).toContain("broken");
  });
});

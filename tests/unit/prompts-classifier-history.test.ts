import { describe, it, expect } from "vitest";
import { buildClassifierSystem } from "../../src/prompts/classifier";
import type { RepoContext, ConversationTurn } from "../../src/types";

const repoCtx: RepoContext = { tree: "src/", readme: "R", recent_issues: [], fetched_at: "t" };

describe("buildClassifierSystem PRIOR_CONVERSATION", () => {
  it("omits PRIOR_CONVERSATION when no turns provided", () => {
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y", repo_context: repoCtx,
      raw_message_text: "hi", attachments_summary: "",
      pending_clarification: null,
      prior_conversation: [],
    });
    const all = blocks.map((b) => b.text).join("\n");
    expect(all).not.toContain("PRIOR_CONVERSATION");
  });

  it("includes PRIOR_CONVERSATION in the LIVE section when turns provided", () => {
    const turns: ConversationTurn[] = [
      { role: "user", text: "first thing", ts: "t1" },
      { role: "assistant", text: "ack", ts: "t2" },
    ];
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y", repo_context: repoCtx,
      raw_message_text: "hi", attachments_summary: "",
      pending_clarification: null,
      prior_conversation: turns,
    });
    expect(blocks[0]!.text).not.toContain("PRIOR_CONVERSATION");
    expect(blocks[1]!.text).toContain("PRIOR_CONVERSATION");
    expect(blocks[1]!.text).toContain("first thing");
    expect(blocks[1]!.text).toContain("ack");
  });

  it("PRIOR_CONVERSATION appears BEFORE pending_clarification when both present", () => {
    const turns: ConversationTurn[] = [{ role: "user", text: "old", ts: "t1" }];
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y", repo_context: repoCtx,
      raw_message_text: "hi", attachments_summary: "",
      pending_clarification: { asked_question_he: "?", original_message: "orig", questions_asked: 1 },
      prior_conversation: turns,
    });
    const live = blocks[1]!.text;
    expect(live.indexOf("PRIOR_CONVERSATION")).toBeLessThan(live.indexOf("Earlier you asked"));
  });

  it("includes capability-honesty section in the cached preamble", () => {
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y", repo_context: repoCtx,
      raw_message_text: "hi", attachments_summary: "",
      pending_clarification: null,
      prior_conversation: [],
    });
    expect(blocks[0]!.text).toMatch(/CAPABILITIES/i);
    expect(blocks[0]!.text).toMatch(/can NOT/i);
    expect(blocks[0]!.text).toMatch(/out_of_scope/);
  });

  it("includes out_of_scope few-shot example in the cached preamble", () => {
    const blocks = buildClassifierSystem({
      reporter_name: "Y", repo: "x/y", repo_context: repoCtx,
      raw_message_text: "hi", attachments_summary: "",
      pending_clarification: null,
      prior_conversation: [],
    });
    expect(blocks[0]!.text).toMatch(/Example 5|out_of_scope/);
    expect(blocks[0]!.text).toMatch(/לתעד דיווחים/);
  });
});

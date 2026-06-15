import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { recordClassification, getRecentClassifications } from "../../src/lib/kv";
import type { ClassificationRecord } from "../../src/types";

function rec(over: Partial<ClassificationRecord> = {}): ClassificationRecord {
  return {
    ts: "2026-06-10T10:00:00.000Z",
    tg_user_id: 1,
    reporter_name: "Yossi",
    repo: "x/y",
    project_id: "y",
    user_text: "the export button is broken",
    result_kind: "final",
    type: "bug",
    severity: "high",
    should_create_issue: true,
    is_followup_to_issue: null,
    issue_number: 42,
    github_search_calls: 2,
    github_total_matches: 0,
    semantic_calls: 2,
    top_semantic_score: 0.74,
    low_grounding: true,
    input_tokens: 10000,
    output_tokens: 1000,
    cost_cents: 22.5,
    ...over,
  };
}

describe("classification records", () => {
  it("stores a record and lists it back", async () => {
    await recordClassification(env as any, rec({ ts: "2026-06-10T10:00:00.000Z", issue_number: 1 }));
    const recent = await getRecentClassifications(env as any, 10);
    expect(recent.some((r) => r.issue_number === 1)).toBe(true);
  });

  it("lists recent records newest-first", async () => {
    await recordClassification(env as any, rec({ ts: "2026-06-11T08:00:00.000Z", tg_user_id: 7, issue_number: 100 }));
    await recordClassification(env as any, rec({ ts: "2026-06-11T09:00:00.000Z", tg_user_id: 7, issue_number: 101 }));
    const recent = await getRecentClassifications(env as any, 50);
    const idx100 = recent.findIndex((r) => r.issue_number === 100);
    const idx101 = recent.findIndex((r) => r.issue_number === 101);
    expect(idx101).toBeLessThan(idx100); // 09:00 (101) appears before 08:00 (100)
  });

  it("honors the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await recordClassification(env as any, rec({ ts: `2026-06-12T0${i}:00:00.000Z`, tg_user_id: 9, issue_number: 200 + i }));
    }
    const recent = await getRecentClassifications(env as any, 3);
    expect(recent.length).toBeLessThanOrEqual(3);
  });

  it("is a safe no-op when the CLASSIFICATIONS binding is absent", async () => {
    const noBinding = { ...env, CLASSIFICATIONS: undefined };
    await expect(recordClassification(noBinding as any, rec())).resolves.toBeUndefined();
    expect(await getRecentClassifications(noBinding as any, 10)).toEqual([]);
  });
});

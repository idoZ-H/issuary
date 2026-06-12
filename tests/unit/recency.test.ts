import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { findRecentActivity, recordActivity } from "../../src/pipeline/recency";

describe("recency aggregator", () => {
  it("returns null when no activity exists", async () => {
    const r = await findRecentActivity(env as any, 10, "y");
    expect(r).toBeNull();
  });

  it("returns the issue when a recent activity is recorded", async () => {
    await recordActivity(env as any, 11, "y", {
      issue_url: "https://github.com/x/y/issues/5",
      repo: "x/y",
      issue_number: 5,
      last_message_at: new Date().toISOString(),
    });
    const r = await findRecentActivity(env as any, 11, "y");
    expect(r?.issue_number).toBe(5);
  });

  it("isolates activity per user", async () => {
    await recordActivity(env as any, 12, "y", {
      issue_url: "https://github.com/x/y/issues/9",
      repo: "x/y",
      issue_number: 9,
      last_message_at: new Date().toISOString(),
    });
    expect(await findRecentActivity(env as any, 13, "y")).toBeNull();
  });
});

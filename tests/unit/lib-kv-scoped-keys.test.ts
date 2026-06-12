import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getRecentActivity, putRecentActivity } from "../../src/lib/kv";

describe("project-scoped recent activity", () => {
  it("writes and reads under the new key shape (tg_user_id:project_id)", async () => {
    await putRecentActivity(env as any, 100, "acme-core", {
      issue_url: "https://github.com/x/y/issues/5",
      repo: "workfluxs/acme-core",
      issue_number: 5,
      last_message_at: "2026-05-08T00:00:00Z",
    });
    const r = await getRecentActivity(env as any, 100, "acme-core");
    expect(r?.issue_number).toBe(5);
  });

  it("isolates by project — different project_id returns null", async () => {
    await putRecentActivity(env as any, 101, "acme-core", {
      issue_url: "https://github.com/x/y/issues/6",
      repo: "workfluxs/acme-core",
      issue_number: 6,
      last_message_at: "2026-05-08T00:00:00Z",
    });
    expect(await getRecentActivity(env as any, 101, "acme-mobile")).toBeNull();
  });

  it("falls back to legacy un-suffixed key when new key is absent", async () => {
    await (env as any).RECENT_ACTIVITY.put(
      "102",
      JSON.stringify({
        issue_url: "https://github.com/x/y/issues/7",
        repo: "workfluxs/acme-core",
        issue_number: 7,
        last_message_at: "2026-05-08T00:00:00Z",
      })
    );
    const r = await getRecentActivity(env as any, 102, "acme-core");
    expect(r?.issue_number).toBe(7);
  });
});

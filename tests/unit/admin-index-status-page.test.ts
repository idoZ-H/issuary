import { describe, it, expect } from "vitest";
import { renderIndexStatusPage, handleRebuildIndex } from "../../src/admin/pages/index-status";
import type { IndexStatusRow } from "../../src/admin/index-status";
import type { UsageSnapshot } from "../../src/admin/usage";

const admin = { tg_user_id: 1, session_id: "s" };
const usage: UsageSnapshot = { ok: true, neurons_today: 1200, neuron_daily_free: 10000, neurons_by_day: [{ date: "2026-06-05", neurons: 1200 }], kv_ops: { read: 10, write: 2, list: 3, delete: 0 } };

const rowComplete: IndexStatusRow = { repo: "o/r1", clients: [{ tg_user_id: 5, client_name: "Acme", project_id: "p" }], semantic_enabled: true, state: "complete", indexed_files: 5, total_files: 5, chunk_count: 10, chunker_version: "linewin-v2", version_stale: false, fetched_at: "2026-06-05T00:00:00Z", age_ms: 1000 };
const rowBuilding: IndexStatusRow = { ...rowComplete, repo: "o/r2", state: "building", indexed_files: 2, total_files: 10 };

describe("renderIndexStatusPage", () => {
  it("renders rows, progress, rebuild button, usage panel; no meta-refresh when all complete", async () => {
    const res = await renderIndexStatusPage({} as any, admin, { collect: async () => [rowComplete], usage: async () => usage });
    const html = await res.text();
    expect(html).toMatch(/o\/r1/);
    expect(html).toMatch(/5\s*\/\s*5/);
    expect(html).toMatch(/index\/rebuild/);
    expect(html).toMatch(/1,?200/);            // neurons today
    expect(html).toMatch(/incrementally/);     // freshness explainer
    expect(html).not.toMatch(/http-equiv="refresh"/);
  });
  it("emits meta-refresh when a repo is building", async () => {
    const res = await renderIndexStatusPage({} as any, admin, { collect: async () => [rowBuilding], usage: async () => usage });
    const html = await res.text();
    expect(html).toMatch(/http-equiv="refresh"/);
    expect(html).toMatch(/2\s*\/\s*10/);
  });
  it("shows not-configured usage gracefully", async () => {
    const res = await renderIndexStatusPage({} as any, admin, { collect: async () => [rowComplete], usage: async () => ({ ...usage, ok: false, error: "not configured" }) });
    const html = await res.text();
    expect(html).toMatch(/not configured/i);
  });
});

describe("handleRebuildIndex", () => {
  it("deletes manifest and kicks off build", async () => {
    const deleted: string[] = []; const kicked: string[] = [];
    const req = new Request("https://w/admin/index/rebuild", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "repo=o/r1" });
    const res = await handleRebuildIndex({} as any, req, { resetIndex: async (_e, r) => { deleted.push(r); }, kickoffIndexBuild: (r) => kicked.push(r) });
    expect(res.status).toBe(302);
    expect(deleted).toContain("o/r1");
    expect(kicked).toContain("o/r1");
  });
  it("ignores invalid repo", async () => {
    const kicked: string[] = [];
    const req = new Request("https://w/admin/index/rebuild", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "repo=notarepo" });
    const res = await handleRebuildIndex({} as any, req, { resetIndex: async () => {}, kickoffIndexBuild: (r) => kicked.push(r) });
    expect(res.status).toBe(302);
    expect(kicked).toEqual([]);
  });
});

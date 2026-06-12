import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { putAdmin, putClient, putIndexManifest, getIndexManifest } from "../../src/lib/kv";

beforeEach(async () => { (env as any).TELEGRAM_BOT_TOKEN = "tt"; await putAdmin(env as any, 100); });

function stubFetch() {
  const calls: any[] = []; const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) { calls.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); }
    return new Response("", { status: 200 });
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
async function loginAsAdmin(): Promise<string> {
  const { calls, restore } = stubFetch();
  try {
    await worker.fetch(new Request("https://w/admin/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "tg_user_id=100" }), env as any, {} as any);
    const token = (calls[0].body.text as string).match(/t=([a-f0-9]+)/)![1];
    const cb = await worker.fetch(new Request(`https://w/admin/callback?t=${token}`), env as any, {} as any);
    return cb.headers.get("set-cookie")!.match(/admin_session=([a-f0-9]+);/)![1]!;
  } finally { restore(); }
}

describe("/admin/index-status", () => {
  it("renders index status for a configured repo", async () => {
    await putClient(env as any, 600, { name: "Acme", telegram_chat_id: 600, active: true, created_at: "2026-01-01T00:00:00Z", projects: [{ id: "p", name_he: "P", repo: "o/idx1", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }], active_project_id: "p", default_project_id: "p" });
    await putIndexManifest(env as any, "o/idx1", { repo: "o/idx1", fetched_at: new Date().toISOString(), chunk_count: 7, chunker_version: "linewin-v2", status: "complete", cursor: 4, paths: ["a", "b", "c", "d"] });
    const sid = await loginAsAdmin();
    const { restore } = stubFetch();
    try {
      const res = await worker.fetch(new Request("https://w/admin/index-status", { headers: { cookie: `admin_session=${sid}` } }), env as any, {} as any);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/o\/idx1/);
      expect(html).toMatch(/4\s*\/\s*4/);
    } finally { restore(); }
  });

  it("rebuild deletes the manifest", async () => {
    await putClient(env as any, 601, { name: "B", telegram_chat_id: 601, active: true, created_at: "2026-01-01T00:00:00Z", projects: [{ id: "p", name_he: "P", repo: "o/idx2", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }], active_project_id: "p", default_project_id: "p" });
    await putIndexManifest(env as any, "o/idx2", { repo: "o/idx2", fetched_at: new Date().toISOString(), chunk_count: 1, chunker_version: "linewin-v2", status: "complete", cursor: 1, paths: ["a"] });
    const sid = await loginAsAdmin();
    const { restore } = stubFetch();
    try {
      const res = await worker.fetch(new Request("https://w/admin/index/rebuild", { method: "POST", headers: { cookie: `admin_session=${sid}`, "content-type": "application/x-www-form-urlencoded" }, body: "repo=o/idx2" }), env as any, {} as any);
      expect(res.status).toBe(302);
      expect(await getIndexManifest(env as any, "o/idx2")).toBeNull();
    } finally { restore(); }
  });
});

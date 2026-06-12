// The admin dashboard hit Cloudflare's free-tier KV list() daily cap (1,000/day)
// because every page load called listClients() -> CLIENTS.list(). These tests pin
// the hardening: a short-TTL cached read for the dashboard (so rapid refreshes
// share one list()), invalidated on client mutations so admin edits still show
// immediately; plus a detector for the quota error so the dashboard can degrade
// to a clear banner instead of a 500.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { listClients, listClientsCached, putClient, deleteClient, isKvQuotaError } from "../../src/lib/kv";
import type { ClientRecord } from "../../src/types";

function rec(tg: number, repo: string): ClientRecord {
  return {
    name: `c${tg}`, telegram_chat_id: tg, active: true, created_at: "2026-01-01T00:00:00Z",
    projects: [{ id: "p", name_he: "P", repo, created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }],
    active_project_id: "p", default_project_id: "p",
  };
}

describe("listClientsCached", () => {
  it("returns the same clients as listClients on a cold cache", async () => {
    await putClient(env as any, 2001, rec(2001, "o/a"));
    const fresh = await listClients(env as any);
    const cached = await listClientsCached(env as any);
    expect(cached.map((c) => c.tg_user_id).sort()).toEqual(fresh.map((c) => c.tg_user_id).sort());
  });

  it("serves a cached snapshot without re-listing within the TTL", async () => {
    await putClient(env as any, 2002, rec(2002, "o/b"));
    const first = await listClientsCached(env as any); // populates cache
    // Mutate CLIENTS directly, bypassing putClient's invalidation.
    await (env as any).CLIENTS.put("2003", JSON.stringify(rec(2003, "o/c")));
    const second = await listClientsCached(env as any);
    // Cache hit: the directly-added 2003 is not visible yet, count unchanged.
    expect(second.some((c) => c.tg_user_id === 2003)).toBe(false);
    expect(second.length).toBe(first.length);
  });

  it("putClient invalidates the cache so a new client appears immediately", async () => {
    await listClientsCached(env as any); // warm cache
    await putClient(env as any, 2004, rec(2004, "o/d"));
    const after = await listClientsCached(env as any);
    expect(after.some((c) => c.tg_user_id === 2004)).toBe(true);
  });

  it("deleteClient invalidates the cache so a removed client disappears", async () => {
    await putClient(env as any, 2005, rec(2005, "o/e"));
    await listClientsCached(env as any); // warm cache (includes 2005)
    await deleteClient(env as any, 2005);
    const after = await listClientsCached(env as any);
    expect(after.some((c) => c.tg_user_id === 2005)).toBe(false);
  });
});

describe("isKvQuotaError", () => {
  it("detects the KV list daily-limit error", () => {
    expect(isKvQuotaError(new Error("KV list() limit exceeded for the day."))).toBe(true);
  });
  it("ignores unrelated errors and non-errors", () => {
    expect(isKvQuotaError(new Error("some other failure"))).toBe(false);
    expect(isKvQuotaError(null)).toBe(false);
  });
});

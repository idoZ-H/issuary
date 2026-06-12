// tests/unit/lib-kv.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getClient, putClient, getRecentActivity, putRecentActivity, isAdmin, putAdmin, dedupCheck } from "../../src/lib/kv";
import type { ClientRecord } from "../../src/types";

describe("kv accessors", () => {
  it("round-trips a client record", async () => {
    const record: ClientRecord = {
      name: "Yossi",
      telegram_chat_id: 42,
      active: true,
      created_at: "2026-04-29T00:00:00Z",
      projects: [{ id: "acme-core", name_he: "Yossi", repo: "workfluxs/acme-core", created_at: "2026-04-29T00:00:00Z", semantic_enabled: true }],
      active_project_id: "acme-core",
      default_project_id: "acme-core",
    };
    await putClient(env as any, 123, record);
    const got = await getClient(env as any, 123);
    expect(got).toEqual(record);
  });

  it("returns null for unknown client", async () => {
    const got = await getClient(env as any, 999);
    expect(got).toBeNull();
  });

  it("recent activity expires via TTL", async () => {
    await putRecentActivity(env as any, 7, "y", {
      issue_url: "https://github.com/x/y/issues/1",
      repo: "x/y",
      issue_number: 1,
      last_message_at: "2026-04-29T00:00:00Z",
    });
    const got = await getRecentActivity(env as any, 7, "y");
    expect(got?.issue_number).toBe(1);
  });

  it("isAdmin returns false for missing record and true after putAdmin", async () => {
    const before = await isAdmin(env as any, 5151);
    expect(before).toBe(false);
    await putAdmin(env as any, 5151);
    const after = await isAdmin(env as any, 5151);
    expect(after).toBe(true);
  });

  it("dedupCheck returns false on first call, true on second", async () => {
    const k = "telegram_update:abc123";
    const first = await dedupCheck(env as any, k);
    expect(first).toBe(false);
    const second = await dedupCheck(env as any, k);
    expect(second).toBe(true);
  });
});

describe("semantic_enabled normalization", () => {
  it("backfills semantic_enabled=true on a multi-project record missing the field", async () => {
    await (env as any).CLIENTS.put("9001", JSON.stringify({
      name: "Acme", telegram_chat_id: 9001, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "p1", name_he: "p1", repo: "o/r", created_at: "2026-01-01T00:00:00Z" }],
      active_project_id: "p1", default_project_id: "p1",
    }));
    const c = await getClient(env as any, 9001);
    expect(c!.projects[0]!.semantic_enabled).toBe(true);
  });

  it("backfills semantic_enabled=true when normalizing a legacy single-repo record", async () => {
    await (env as any).CLIENTS.put("9002", JSON.stringify({
      name: "Legacy", telegram_chat_id: 9002, active: true, created_at: "2026-01-01T00:00:00Z", repo: "o/legacy",
    }));
    const c = await getClient(env as any, 9002);
    expect(c!.projects[0]!.semantic_enabled).toBe(true);
  });

  it("preserves an explicit semantic_enabled=false", async () => {
    await (env as any).CLIENTS.put("9003", JSON.stringify({
      name: "Off", telegram_chat_id: 9003, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "p1", name_he: "p1", repo: "o/r", created_at: "2026-01-01T00:00:00Z", semantic_enabled: false }],
      active_project_id: "p1", default_project_id: "p1",
    }));
    const c = await getClient(env as any, 9003);
    expect(c!.projects[0]!.semantic_enabled).toBe(false);
  });
});

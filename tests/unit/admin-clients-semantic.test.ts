import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  handleNewClientPost, handleAddProject, handleSetProjectSemantic,
  handleNewClientGet, renderClientDetail,
} from "../../src/admin/pages/clients";
import { putClient } from "../../src/lib/kv";

const currentAdmin = { tg_user_id: 1, session_id: "s" };
const okValidate = { validateRepo: async () => ({ ok: true } as const) };

let restoreFetch: () => void;
beforeEach(() => {
  (env as any).TELEGRAM_BOT_TOKEN = "tt";
  const original = globalThis.fetch;
  restoreFetch = () => { globalThis.fetch = original; };
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }))) as any;
});
afterEach(() => restoreFetch());

function formPost(body: string): Request {
  return new Request("https://w/x", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("admin-ui semantic_enabled", () => {
  it("new client with the semantic checkbox on stores semantic_enabled=true and kicks off the build", async () => {
    const kicked: string[] = [];
    const res = await handleNewClientPost(env as any, formPost(
      "tg_user_id=700&name=Acme&repo=owner/repo&semantic_enabled=on",
    ), currentAdmin, { ...okValidate, kickoffIndexBuild: (r: string) => kicked.push(r) });
    expect(res.status).toBe(302);
    const raw = await (env as any).CLIENTS.get("700", "json");
    expect(raw.projects[0].semantic_enabled).toBe(true);
    expect(kicked).toContain("owner/repo");
  });

  it("new client with the semantic checkbox off stores semantic_enabled=false and does not kick off", async () => {
    const kicked: string[] = [];
    await handleNewClientPost(env as any, formPost(
      "tg_user_id=701&name=Acme&repo=owner/repo",
    ), currentAdmin, { ...okValidate, kickoffIndexBuild: (r: string) => kicked.push(r) });
    const raw = await (env as any).CLIENTS.get("701", "json");
    expect(raw.projects[0].semantic_enabled).toBe(false);
    expect(kicked).toEqual([]);
  });

  it("add project honors the semantic checkbox and kicks off when on", async () => {
    await putClient(env as any, 702, {
      name: "Acme", telegram_chat_id: 702, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "first", name_he: "F", repo: "x/first", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }],
      active_project_id: "first", default_project_id: "first",
    });
    const kicked: string[] = [];
    await handleAddProject(env as any, formPost("repo=x/second&semantic_enabled=on"), 702, { ...okValidate, kickoffIndexBuild: (r: string) => kicked.push(r) });
    const raw = await (env as any).CLIENTS.get("702", "json");
    expect(raw.projects.find((p: any) => p.id === "second").semantic_enabled).toBe(true);
    expect(kicked).toContain("x/second");
  });

  it("the per-project semantic toggle flips the flag off", async () => {
    await putClient(env as any, 703, {
      name: "Acme", telegram_chat_id: 703, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "p", name_he: "P", repo: "x/p", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }],
      active_project_id: "p", default_project_id: "p",
    });
    const res = await handleSetProjectSemantic(env as any, formPost("enabled=off"), 703, "p", {});
    expect(res.status).toBe(302);
    const raw = await (env as any).CLIENTS.get("703", "json");
    expect(raw.projects[0].semantic_enabled).toBe(false);
  });

  it("the per-project semantic toggle flips the flag on and kicks off the build", async () => {
    await putClient(env as any, 704, {
      name: "Acme", telegram_chat_id: 704, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "p", name_he: "P", repo: "x/p", created_at: "2026-01-01T00:00:00Z", semantic_enabled: false }],
      active_project_id: "p", default_project_id: "p",
    });
    const kicked: string[] = [];
    await handleSetProjectSemantic(env as any, formPost("enabled=on"), 704, "p", { kickoffIndexBuild: (r: string) => kicked.push(r) });
    const raw = await (env as any).CLIENTS.get("704", "json");
    expect(raw.projects[0].semantic_enabled).toBe(true);
    expect(kicked).toContain("x/p");
  });

  it("the new-client form renders the semantic checkbox checked", async () => {
    const res = await handleNewClientGet(currentAdmin);
    const html = await res.text();
    expect(html).toMatch(/name="semantic_enabled"/);
    expect(html).toMatch(/checked/);
  });

  it("the client detail view renders a per-project semantic toggle", async () => {
    await putClient(env as any, 705, {
      name: "Acme", telegram_chat_id: 705, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "p", name_he: "P", repo: "x/p", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }],
      active_project_id: "p", default_project_id: "p",
    });
    const res = await renderClientDetail(env as any, 705, currentAdmin);
    const html = await res.text();
    expect(html).toMatch(/projects\/p\/semantic/);
  });

  it("client detail rows show index status", async () => {
    await putClient(env as any, 706, {
      name: "Acme", telegram_chat_id: 706, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "p", name_he: "P", repo: "x/idx", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }],
      active_project_id: "p", default_project_id: "p",
    });
    const { putIndexManifest } = await import("../../src/lib/kv");
    await putIndexManifest(env as any, "x/idx", { repo: "x/idx", fetched_at: new Date().toISOString(), chunk_count: 9, chunker_version: "linewin-v2", status: "building", cursor: 3, paths: ["a", "b", "c", "d", "e", "f"] });
    const res = await renderClientDetail(env as any, 706, currentAdmin);
    const html = await res.text();
    expect(html).toMatch(/building/);
    expect(html).toMatch(/3\s*\/\s*6/);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { putAdmin, putClient, getClient } from "../../src/lib/kv";

beforeEach(async () => {
  (env as any).TELEGRAM_BOT_TOKEN = "tt";
  await putAdmin(env as any, 100);
});

function stubFetch() {
  const calls: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    return new Response("", { status: 200 });
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function loginAsAdmin(): Promise<string> {
  const { calls, restore } = stubFetch();
  try {
    await worker.fetch(new Request("https://w/admin/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "tg_user_id=100",
    }), env as any, {} as any);
    const token = (calls[0].body.text as string).match(/t=([a-f0-9]+)/)![1];
    const cb = await worker.fetch(new Request(`https://w/admin/callback?t=${token}`), env as any, {} as any);
    const sid = cb.headers.get("set-cookie")!.match(/admin_session=([a-f0-9]+);/)![1]!;
    return sid;
  } finally { restore(); }
}

describe("/admin/clients page", () => {
  it("GET /admin/clients renders empty state when no clients", async () => {
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/clients", {
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/no clients yet/);
  });

  it("GET /admin/clients lists existing clients with project counts", async () => {
    await putClient(env as any, 500, {
      name: "Alice", telegram_chat_id: 500, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [
        { id: "alpha", name_he: "Alpha", repo: "org/alpha", created_at: "2026-01-01T00:00:00Z" },
        { id: "beta", name_he: "Beta", repo: "org/beta", created_at: "2026-01-01T00:00:00Z" },
      ],
      active_project_id: "alpha", default_project_id: "alpha",
    });
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/clients", {
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/1 client.*2 projects/);
    expect(html).toMatch(/Alice/);
    expect(html).toMatch(/alpha/);
    expect(html).toMatch(/beta/);
  });

  it("GET /admin/clients/new renders the form", async () => {
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/clients/new", {
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Add client/);
  });

  it("POST /admin/clients/new validates required fields", async () => {
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/clients/new", {
      method: "POST",
      headers: { cookie: `admin_session=${sid}`, "content-type": "application/x-www-form-urlencoded" },
      body: "tg_user_id=abc&name=&repo=invalid",
    }), env as any, {} as any);
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/must be a positive number/);
  });

  it("POST /admin/clients/new rejects invalid repo format", async () => {
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/clients/new", {
      method: "POST",
      headers: { cookie: `admin_session=${sid}`, "content-type": "application/x-www-form-urlencoded" },
      body: "tg_user_id=500&name=Alice&repo=notvalid",
    }), env as any, {} as any);
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/owner\/repo/);
  });

  it("POST /admin/clients/update changes name + active + shadow", async () => {
    await putClient(env as any, 600, {
      name: "Bob", telegram_chat_id: 600, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "p1", name_he: "P", repo: "x/y", created_at: "2026-01-01T00:00:00Z" }],
      active_project_id: "p1", default_project_id: "p1",
    });
    const sid = await loginAsAdmin();
    const { restore } = stubFetch();
    try {
      const res = await worker.fetch(new Request("https://w/admin/clients/600/update", {
        method: "POST",
        headers: { cookie: `admin_session=${sid}`, "content-type": "application/x-www-form-urlencoded" },
        body: "name=Bobby&shadow_mode=on",
      }), env as any, {} as any);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/admin/clients/600");
      const c = await getClient(env as any, 600);
      expect(c?.name).toBe("Bobby");
      expect(c?.active).toBe(false);
      expect(c?.shadow_mode).toBe(true);
    } finally { restore(); }
  });

  it("POST /admin/clients/:id/delete removes the client", async () => {
    await putClient(env as any, 700, {
      name: "Carol", telegram_chat_id: 700, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "p", name_he: "P", repo: "x/y", created_at: "2026-01-01T00:00:00Z" }],
      active_project_id: "p", default_project_id: "p",
    });
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/clients/700/delete", {
      method: "POST",
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/clients");
    expect(await getClient(env as any, 700)).toBeNull();
  });

  it("POST /admin/clients/:id/active-project switches the active project", async () => {
    await putClient(env as any, 800, {
      name: "Dan", telegram_chat_id: 800, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [
        { id: "a", name_he: "A", repo: "x/a", created_at: "2026-01-01T00:00:00Z" },
        { id: "b", name_he: "B", repo: "x/b", created_at: "2026-01-01T00:00:00Z" },
      ],
      active_project_id: "a", default_project_id: "a",
    });
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/clients/800/active-project", {
      method: "POST",
      headers: { cookie: `admin_session=${sid}`, "content-type": "application/x-www-form-urlencoded" },
      body: "project_id=b",
    }), env as any, {} as any);
    expect(res.status).toBe(302);
    const c = await getClient(env as any, 800);
    expect(c?.active_project_id).toBe("b");
  });

  it("POST /admin/clients/:id/projects/:pid/delete removes a project", async () => {
    await putClient(env as any, 900, {
      name: "Eve", telegram_chat_id: 900, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [
        { id: "keep", name_he: "K", repo: "x/k", created_at: "2026-01-01T00:00:00Z" },
        { id: "drop", name_he: "D", repo: "x/d", created_at: "2026-01-01T00:00:00Z" },
      ],
      active_project_id: "keep", default_project_id: "keep",
    });
    const sid = await loginAsAdmin();
    const { restore } = stubFetch();
    try {
      const res = await worker.fetch(new Request("https://w/admin/clients/900/projects/drop/delete", {
        method: "POST",
        headers: { cookie: `admin_session=${sid}` },
      }), env as any, {} as any);
      expect(res.status).toBe(302);
      const c = await getClient(env as any, 900);
      expect(c?.projects.map((p) => p.id)).toEqual(["keep"]);
    } finally { restore(); }
  });

  it("POST /admin/clients/:id/projects/:pid/delete refuses when only one project remains", async () => {
    await putClient(env as any, 950, {
      name: "Frank", telegram_chat_id: 950, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "only", name_he: "O", repo: "x/o", created_at: "2026-01-01T00:00:00Z" }],
      active_project_id: "only", default_project_id: "only",
    });
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/clients/950/projects/only/delete", {
      method: "POST",
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(302);
    const c = await getClient(env as any, 950);
    expect(c?.projects.length).toBe(1);
  });

  it("GET /admin/clients/:id for unknown client returns 404", async () => {
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/clients/99999", {
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not found/i);
  });
});

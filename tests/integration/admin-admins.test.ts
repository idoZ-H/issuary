import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { putAdmin, listAdmins, isAdmin } from "../../src/lib/kv";

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
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "tg_user_id=100",
    }), env as any, {} as any);
    const token = (calls[0].body.text as string).match(/t=([a-f0-9]+)/)![1];
    const cb = await worker.fetch(new Request(`https://w/admin/callback?t=${token}`), env as any, {} as any);
    return cb.headers.get("set-cookie")!.match(/admin_session=([a-f0-9]+);/)![1]!;
  } finally { restore(); }
}

describe("/admin/admins page", () => {
  it("lists the current admin with a 'you' badge and a disabled remove button", async () => {
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/admins", {
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/>100</);
    expect(html).toMatch(/badge-ok">you/);
    expect(html).toMatch(/disabled[^>]*>remove/);
  });

  it("adds a new admin and re-renders with both rows", async () => {
    const sid = await loginAsAdmin();
    const addRes = await worker.fetch(new Request("https://w/admin/admins", {
      method: "POST",
      headers: { cookie: `admin_session=${sid}`, "content-type": "application/x-www-form-urlencoded" },
      body: "tg_user_id=555",
    }), env as any, {} as any);
    expect(addRes.status).toBe(302);
    expect(addRes.headers.get("location")).toBe("/admin/admins");
    expect(await isAdmin(env as any, 555)).toBe(true);
    const list = await listAdmins(env as any);
    expect(list).toEqual([100, 555]);
  });

  it("removes another admin", async () => {
    await putAdmin(env as any, 555);
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/admins/555/delete", {
      method: "POST",
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(302);
    expect(await isAdmin(env as any, 555)).toBe(false);
  });

  it("refuses to remove the currently signed-in admin", async () => {
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/admins/100/delete", {
      method: "POST",
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(302);
    expect(await isAdmin(env as any, 100)).toBe(true);
  });

  it("ignores invalid tg_user_id on add (no-op redirect)", async () => {
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/admins", {
      method: "POST",
      headers: { cookie: `admin_session=${sid}`, "content-type": "application/x-www-form-urlencoded" },
      body: "tg_user_id=notanumber",
    }), env as any, {} as any);
    expect(res.status).toBe(302);
    const list = await listAdmins(env as any);
    expect(list).toEqual([100]);
  });
});

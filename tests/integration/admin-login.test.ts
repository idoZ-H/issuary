import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { putAdmin } from "../../src/lib/kv";

beforeEach(async () => {
  (env as any).TELEGRAM_BOT_TOKEN = "tt";
  (env as any).TELEGRAM_WEBHOOK_SECRET = "secret";
  await putAdmin(env as any, 100);
});

function stubTelegram(captured: { calls: any[] }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      captured.calls.push({ url, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    return new Response("", { status: 200 });
  }) as any;
  return () => { globalThis.fetch = original; };
}

describe("/admin login flow", () => {
  it("GET /admin/login renders the sign-in form", async () => {
    const req = new Request("https://w/admin/login");
    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Sign in/);
    expect(html).toMatch(/name="tg_user_id"/);
  });

  it("redirects unauthenticated requests to /admin/login", async () => {
    const req = new Request("https://w/admin");
    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/admin\/login/);
  });

  it("full login flow: POST /admin/login → callback → /admin", async () => {
    const captured = { calls: [] as any[] };
    const restore = stubTelegram(captured);
    try {
      // 1. POST login.
      const loginReq = new Request("https://w/admin/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "tg_user_id=100",
      });
      const loginRes = await worker.fetch(loginReq, env as any, {} as any);
      expect(loginRes.status).toBe(200);
      expect(await loginRes.text()).toMatch(/Check your Telegram/);

      // 2. Telegram DM was sent with a callback URL.
      expect(captured.calls.length).toBe(1);
      const dmText = captured.calls[0].body.text as string;
      const tokenMatch = dmText.match(/\/admin\/callback\?t=([a-f0-9]{64})/);
      expect(tokenMatch).toBeTruthy();
      const token = tokenMatch![1];

      // 3. GET callback → 302 to /admin with Set-Cookie.
      const cbReq = new Request(`https://w/admin/callback?t=${token}`);
      const cbRes = await worker.fetch(cbReq, env as any, {} as any);
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get("location")).toBe("/admin");
      const setCookie = cbRes.headers.get("set-cookie");
      expect(setCookie).toMatch(/^admin_session=[a-f0-9]{64};/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/Secure/);
      expect(setCookie).toMatch(/SameSite=Lax/);

      // 4. Subsequent GET /admin with cookie returns the dashboard.
      const sid = setCookie!.match(/admin_session=([a-f0-9]+);/)![1]!;
      const dashReq = new Request("https://w/admin", { headers: { cookie: `admin_session=${sid}` } });
      const dashRes = await worker.fetch(dashReq, env as any, {} as any);
      expect(dashRes.status).toBe(200);
      const dashHtml = await dashRes.text();
      expect(dashHtml).toMatch(/Clients/);
      // Header shows the signed-in admin's tg_user_id.
      expect(dashHtml).toMatch(/>100</);
    } finally { restore(); }
  });

  it("non-admin tg_user_id gets the same 'check Telegram' page but no DM is sent", async () => {
    const captured = { calls: [] as any[] };
    const restore = stubTelegram(captured);
    try {
      const req = new Request("https://w/admin/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "tg_user_id=999",
      });
      const res = await worker.fetch(req, env as any, {} as any);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/Check your Telegram/);
      expect(captured.calls.length).toBe(0);
    } finally { restore(); }
  });

  it("invalid login token redirects to /admin/login?reason=invalid", async () => {
    const req = new Request("https://w/admin/callback?t=nope");
    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/reason=invalid/);
  });

  it("logout clears the cookie and redirects to /admin/login", async () => {
    const captured = { calls: [] as any[] };
    const restore = stubTelegram(captured);
    try {
      // login first.
      await worker.fetch(new Request("https://w/admin/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "tg_user_id=100",
      }), env as any, {} as any);
      const token = (captured.calls[0].body.text as string).match(/t=([a-f0-9]+)/)![1];
      const cb = await worker.fetch(new Request(`https://w/admin/callback?t=${token}`), env as any, {} as any);
      const sid = cb.headers.get("set-cookie")!.match(/admin_session=([a-f0-9]+);/)![1]!;

      const logoutRes = await worker.fetch(new Request("https://w/admin/logout", {
        method: "POST",
        headers: { cookie: `admin_session=${sid}` },
      }), env as any, {} as any);
      expect(logoutRes.status).toBe(302);
      expect(logoutRes.headers.get("location")).toBe("/admin/login");
      const cleared = logoutRes.headers.get("set-cookie");
      expect(cleared).toMatch(/Max-Age=0/);

      // Cookie is now invalid.
      const stillReq = new Request("https://w/admin", { headers: { cookie: `admin_session=${sid}` } });
      const stillRes = await worker.fetch(stillReq, env as any, {} as any);
      expect(stillRes.status).toBe(302);
    } finally { restore(); }
  });

  it("invalid tg_user_id input on login form returns 422 with error flash", async () => {
    const req = new Request("https://w/admin/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "tg_user_id=abc",
    });
    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/doesn&#39;t look like a valid/i);
  });

  it("/admin/static/app.css serves the stylesheet", async () => {
    const req = new Request("https://w/admin/static/app.css");
    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/css/);
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    expect(await res.text()).toMatch(/JetBrains Mono/);
  });
});

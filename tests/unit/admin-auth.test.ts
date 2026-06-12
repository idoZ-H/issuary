import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  parseCookies, startLogin, completeLogin, requireAuth, logout, COOKIE_NAME,
} from "../../src/admin/auth";
import { putAdmin } from "../../src/lib/kv";

beforeEach(async () => {
  await putAdmin(env as any, 100);
});

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    const req = new Request("https://x/", { headers: { cookie: "a=1" } });
    expect(parseCookies(req)).toEqual({ a: "1" });
  });

  it("parses multiple cookies and trims whitespace", () => {
    const req = new Request("https://x/", { headers: { cookie: "a=1; b=2 ; c=hello world" } });
    expect(parseCookies(req)).toEqual({ a: "1", b: "2", c: "hello world" });
  });

  it("returns empty object when cookie header missing", () => {
    const req = new Request("https://x/");
    expect(parseCookies(req)).toEqual({});
  });
});

describe("startLogin", () => {
  it("sends a DM with a sign-in URL to a valid admin", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    await startLogin(env as any, tg as any, 100, "https://example.com");
    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = (tg.sendMessage.mock.calls as any[])[0]!;
    expect(chatId).toBe(100);
    expect(text).toMatch(/Admin sign-in link/);
    expect(text).toMatch(/https:\/\/example\.com\/admin\/callback\?t=[a-f0-9]{64}/);
  });

  it("is a silent no-op for non-admin tg_user_id", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    await startLogin(env as any, tg as any, 999, "https://example.com");
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("is a silent no-op for NaN/invalid IDs", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    await startLogin(env as any, tg as any, NaN, "https://example.com");
    await startLogin(env as any, tg as any, 0, "https://example.com");
    await startLogin(env as any, tg as any, -5, "https://example.com");
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });
});

describe("completeLogin → requireAuth → logout", () => {
  async function loginCycle(): Promise<{ token: string; cookie: string }> {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    await startLogin(env as any, tg as any, 100, "https://example.com");
    const text = ((tg.sendMessage.mock.calls as any[])[0]![1]) as string;
    const m = text.match(/t=([a-f0-9]{64})/);
    expect(m).toBeTruthy();
    const token = m![1]!;
    const result = await completeLogin(env as any, token);
    expect(result.ok).toBe(true);
    return { token, cookie: result.sessionCookie! };
  }

  it("issues a session cookie and authenticates subsequent requests", async () => {
    const { cookie } = await loginCycle();
    expect(cookie).toMatch(new RegExp(`^${COOKIE_NAME}=[a-f0-9]{64};`));
    const sid = cookie.slice(COOKIE_NAME.length + 1, COOKIE_NAME.length + 1 + 64);
    const req = new Request("https://x/admin", { headers: { cookie: `${COOKIE_NAME}=${sid}` } });
    const admin = await requireAuth(env as any, req);
    expect(admin?.tg_user_id).toBe(100);
  });

  it("rejects a stale (already-used) token", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    await startLogin(env as any, tg as any, 100, "https://example.com");
    const token = ((tg.sendMessage.mock.calls as any[])[0]![1] as string).match(/t=([a-f0-9]{64})/)![1]!;
    const first = await completeLogin(env as any, token);
    expect(first.ok).toBe(true);
    const second = await completeLogin(env as any, token);
    expect(second.ok).toBe(false);
  });

  it("rejects unauthenticated requests", async () => {
    const req = new Request("https://x/admin");
    expect(await requireAuth(env as any, req)).toBeNull();
  });

  it("invalidates session when the admin is removed", async () => {
    const { cookie } = await loginCycle();
    const sid = cookie.slice(COOKIE_NAME.length + 1, COOKIE_NAME.length + 1 + 64);
    await (env as any).ADMINS.delete("100");
    const req = new Request("https://x/admin", { headers: { cookie: `${COOKIE_NAME}=${sid}` } });
    expect(await requireAuth(env as any, req)).toBeNull();
  });

  it("logout clears the session", async () => {
    const { cookie } = await loginCycle();
    const sid = cookie.slice(COOKIE_NAME.length + 1, COOKIE_NAME.length + 1 + 64);
    const req = new Request("https://x/admin", { headers: { cookie: `${COOKIE_NAME}=${sid}` } });
    const cleared = await logout(env as any, req);
    expect(cleared).toMatch(/Max-Age=0/);
    const req2 = new Request("https://x/admin", { headers: { cookie: `${COOKIE_NAME}=${sid}` } });
    expect(await requireAuth(env as any, req2)).toBeNull();
  });
});

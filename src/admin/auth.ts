// Magic-link authentication for /admin/*.
//
// Sign-in flow:
//   1. User submits tg_user_id at /admin/login.
//   2. We mint a single-use token, store at ADMIN_SESSIONS["login:<token>"]
//      with 10-min TTL, and DM the link to the admin via Telegram.
//   3. User clicks link → /admin/callback?t=<token>. We swap the login token
//      for a 30-day session and set an HttpOnly cookie.
//
// Session check: every /admin route except /admin/login*, /admin/callback,
// /admin/static/* runs requireAuth() which validates the cookie + re-verifies
// the session's tg_user_id is still in ADMINS (so de-admining takes effect
// after the next request, not after the session expires).

import type { Env, AdminSession, AdminLoginToken } from "../types";
import type { TelegramClient } from "../lib/telegram";
import { isAdmin } from "../lib/kv";

const SESSION_TTL_S = 30 * 24 * 60 * 60;
const LOGIN_TTL_S = 10 * 60;
export const COOKIE_NAME = "admin_session";

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CurrentAdmin {
  tg_user_id: number;
  session_id: string;
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie");
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function sessionCookieHeader(sid: string): string {
  return `${COOKIE_NAME}=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${SESSION_TTL_S}`;
}

function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0`;
}

export async function startLogin(
  env: Env,
  tg: Pick<TelegramClient, "sendMessage">,
  tgUserId: number,
  baseUrl: string,
): Promise<void> {
  // Silent no-op for non-admins. Don't leak which IDs are admins by changing
  // the response shape or timing.
  if (!Number.isFinite(tgUserId) || !(await isAdmin(env, tgUserId))) return;

  const token = randomHex(32);
  const record: AdminLoginToken = {
    tg_user_id: tgUserId,
    created_at: new Date().toISOString(),
  };
  await env.ADMIN_SESSIONS.put(`login:${token}`, JSON.stringify(record), {
    expirationTtl: LOGIN_TTL_S,
  });
  const url = `${baseUrl}/admin/callback?t=${token}`;
  await tg.sendMessage(
    tgUserId,
    `Admin sign-in link (expires in 10 minutes):\n\n${url}\n\nIf you didn't request this, ignore the message.`,
  );
}

export interface CompleteLoginResult {
  ok: boolean;
  sessionCookie?: string;
}

export async function completeLogin(env: Env, token: string): Promise<CompleteLoginResult> {
  if (!token) return { ok: false };
  const key = `login:${token}`;
  const record = await env.ADMIN_SESSIONS.get<AdminLoginToken>(key, "json");
  if (!record) return { ok: false };
  // Single-use: delete before minting the session. Even if the session put
  // fails afterwards, the login token is gone and the user retries.
  await env.ADMIN_SESSIONS.delete(key);
  const sid = randomHex(32);
  const session: AdminSession = {
    tg_user_id: record.tg_user_id,
    created_at: new Date().toISOString(),
  };
  await env.ADMIN_SESSIONS.put(`session:${sid}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_S,
  });
  return { ok: true, sessionCookie: sessionCookieHeader(sid) };
}

export async function requireAuth(env: Env, req: Request): Promise<CurrentAdmin | null> {
  const cookies = parseCookies(req);
  const sid = cookies[COOKIE_NAME];
  if (!sid) return null;
  const session = await env.ADMIN_SESSIONS.get<AdminSession>(`session:${sid}`, "json");
  if (!session) return null;
  if (!(await isAdmin(env, session.tg_user_id))) {
    // Session belongs to a former admin. Invalidate and reject.
    await env.ADMIN_SESSIONS.delete(`session:${sid}`);
    return null;
  }
  return { tg_user_id: session.tg_user_id, session_id: sid };
}

export async function logout(env: Env, req: Request): Promise<string> {
  const cookies = parseCookies(req);
  const sid = cookies[COOKIE_NAME];
  if (sid) await env.ADMIN_SESSIONS.delete(`session:${sid}`);
  return clearCookieHeader();
}

export function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 302,
    headers: { location, ...extraHeaders },
  });
}

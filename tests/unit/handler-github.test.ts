import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleGitHubWebhook } from "../../src/handlers/github";
import { putIssueChat } from "../../src/lib/kv";

const SECRET = "gh-secret";

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

beforeEach(async () => {
  (env as any).GITHUB_WEBHOOK_SECRET = SECRET;
  (env as any).TELEGRAM_BOT_TOKEN = "tok";
  (env as any).ANTHROPIC_API_KEY = "ak";
  await putIssueChat(env as any, "x/y", 42, { tg_user_id: 50, telegram_chat_id: 50 });
});

describe("handleGitHubWebhook", () => {
  it("rejects on bad signature", async () => {
    const body = JSON.stringify({ action: "closed" });
    const req = new Request("https://w/github/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha256=deadbeef", "content-type": "application/json", "X-GitHub-Event": "issues" },
      body,
    });
    const res = await handleGitHubWebhook(req, env as any, undefined, {});
    expect(res.status).toBe(401);
  });

  it("DMs the originating client when an issue is closed", async () => {
    const tgSent: Array<[number, string]> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (c: number, t: string) => { tgSent.push([c, t]); return { message_id: 1 }; }),
    };
    const draft = vi.fn(async () => "תיקנו! תודה.");
    const body = JSON.stringify({
      action: "closed",
      issue: { number: 42, title: "Bug", state: "closed", body: "" },
      repository: { full_name: "x/y" },
      sender: { login: "idoZ" },
      comment: undefined,
    });
    const req = new Request("https://w/github/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": await sign(body), "content-type": "application/json", "X-GitHub-Event": "issues" },
      body,
    });
    const res = await handleGitHubWebhook(req, env as any, undefined, {
      tgFactory: () => fakeTg as any,
      draftClosure: draft as any,
    });
    expect(res.status).toBe(200);
    expect(tgSent).toEqual([[50, "תיקנו! תודה."]]);
  });

  it("notifies Ido and still returns 200 when the closure DM fails to send", async () => {
    (env as any).IDO_INBOX_CHAT_ID = "-100";
    const sent: Array<[number, string]> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (c: number, t: string) => {
        if (c === 50) throw new Error("telegram 403 bot blocked by user");
        sent.push([c, t]);
        return { message_id: 1 };
      }),
    };
    const body = JSON.stringify({
      action: "closed",
      issue: { number: 42, title: "Bug", state: "closed", body: "" },
      repository: { full_name: "x/y" },
      sender: { login: "idoZ" },
      comment: undefined,
    });
    const req = new Request("https://w/github/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": await sign(body), "content-type": "application/json", "X-GitHub-Event": "issues" },
      body,
    });
    const res = await handleGitHubWebhook(req, env as any, undefined, {
      tgFactory: () => fakeTg as any,
      draftClosure: (async () => "תיקנו! תודה.") as any,
    });
    expect(res.status).toBe(200);
    const j = await res.json<any>();
    expect(j.action).toBe("closure_dm_failed");
    expect(sent.some(([c]) => c === -100)).toBe(true); // Ido got an error notice
  });

  it("ignores actions other than 'closed'", async () => {
    const body = JSON.stringify({ action: "opened", issue: { number: 1, title: "T", body: "" }, repository: { full_name: "x/y" }, sender: {} });
    const req = new Request("https://w/github/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": await sign(body), "content-type": "application/json", "X-GitHub-Event": "issues" },
      body,
    });
    const res = await handleGitHubWebhook(req, env as any, undefined, {});
    expect(res.status).toBe(200);
    const j = await res.json<any>();
    expect(j.action).toBe("ignored");
  });

  it("ignores when there's no chat mapping for the issue", async () => {
    const body = JSON.stringify({
      action: "closed",
      issue: { number: 999, title: "T" },
      repository: { full_name: "x/y" },
      sender: {},
    });
    const req = new Request("https://w/github/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": await sign(body), "content-type": "application/json", "X-GitHub-Event": "issues" },
      body,
    });
    const res = await handleGitHubWebhook(req, env as any, undefined, {});
    expect(res.status).toBe(200);
    const j = await res.json<any>();
    expect(j.action).toBe("ignored");
  });

  it("prepends '→ <name_he>' for multi-project clients on closure DM", async () => {
    // Seed multi-project client whose 2nd project owns the closed repo.
    await (env as any).CLIENTS.put("60", JSON.stringify({
      name: "Yossi", telegram_chat_id: 60, active: true, created_at: "2026-05-08T00:00:00Z",
      projects: [
        { id: "core", name_he: "Project Core", repo: "x/core", created_at: "x" },
        { id: "mob", name_he: "Project Mobile", repo: "x/mob", created_at: "x" },
      ],
      active_project_id: "core", default_project_id: "core",
    }));
    await putIssueChat(env as any, "x/mob", 7, { tg_user_id: 60, telegram_chat_id: 60 });
    const sent: Array<[number, string]> = [];
    const fakeTg = { sendMessage: vi.fn(async (c: number, t: string) => { sent.push([c, t]); return { message_id: 1 }; }) };
    const body = JSON.stringify({
      action: "closed",
      issue: { number: 7, title: "Bug" },
      repository: { full_name: "x/mob" },
      sender: { login: "idoZ" },
      comment: undefined,
    });
    const req = new Request("https://w/github/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": await sign(body), "content-type": "application/json", "X-GitHub-Event": "issues" },
      body,
    });
    const res = await handleGitHubWebhook(req, env as any, undefined, {
      tgFactory: () => fakeTg as any,
      draftClosure: (async () => "תיקנו!") as any,
    });
    expect(res.status).toBe(200);
    expect(sent).toEqual([[60, "→ Project Mobile\n─────\nתיקנו!"]]);
  });

  it("does NOT prepend for single-project clients on closure DM", async () => {
    // Legacy single-project record (gets normalized at read time).
    await (env as any).CLIENTS.put("70", JSON.stringify({
      name: "Avi", repo: "x/single", telegram_chat_id: 70, active: true, created_at: "2026-05-08T00:00:00Z",
    }));
    await putIssueChat(env as any, "x/single", 3, { tg_user_id: 70, telegram_chat_id: 70 });
    const sent: Array<[number, string]> = [];
    const fakeTg = { sendMessage: vi.fn(async (c: number, t: string) => { sent.push([c, t]); return { message_id: 1 }; }) };
    const body = JSON.stringify({
      action: "closed",
      issue: { number: 3, title: "Bug" },
      repository: { full_name: "x/single" },
      sender: { login: "idoZ" },
      comment: undefined,
    });
    const req = new Request("https://w/github/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": await sign(body), "content-type": "application/json", "X-GitHub-Event": "issues" },
      body,
    });
    const res = await handleGitHubWebhook(req, env as any, undefined, {
      tgFactory: () => fakeTg as any,
      draftClosure: (async () => "תיקנו!") as any,
    });
    expect(res.status).toBe(200);
    expect(sent).toEqual([[70, "תיקנו!"]]);  // raw, no header
  });
});

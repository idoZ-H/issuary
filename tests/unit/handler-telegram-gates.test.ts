import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleTelegramWebhook } from "../../src/handlers/telegram";
import { putClient, putRepoContext } from "../../src/lib/kv";

const SECRET = "tg-secret";

function makeUpdate(tgUserId: number, text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 50,
      from: { id: tgUserId, first_name: "Y" },
      chat: { id: tgUserId },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function withSecret(body: unknown, secret: string): Request {
  return new Request("https://w/telegram/webhook", {
    method: "POST",
    headers: {
      "X-Telegram-Bot-Api-Secret-Token": secret,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeFakeTg() {
  const sent: Array<[number, string]> = [];
  const tg = {
    sendMessage: vi.fn(async (c: number, t: string) => { sent.push([c, t]); return { message_id: 1 }; }),
    react: vi.fn(async () => undefined),
    getFilePath: vi.fn(),
    downloadFile: vi.fn(),
  };
  return { tg, sent };
}

const fakeGh = () => ({
  searchCode: vi.fn(), searchIssues: vi.fn(), readFile: vi.fn(),
  createIssue: vi.fn(), createComment: vi.fn(),
  getRepoTree: vi.fn(async () => []), getReadme: vi.fn(async () => ""),
  listRecentIssues: vi.fn(async () => []),
});

const chitchatOutput = {
  should_create_issue: false,
  is_followup_to_issue: null,
  type: "chitchat" as const,
  severity: "low" as const,
  title_en: "x", body_he: "x", suggested_labels: [],
  sensitive: false, client_reply_he: "שלום!",
};

describe("handleTelegramWebhook gates", () => {
  beforeEach(async () => {
    (env as any).TELEGRAM_WEBHOOK_SECRET = SECRET;
    (env as any).TELEGRAM_BOT_TOKEN = "test-token";
    (env as any).ANTHROPIC_API_KEY = "ak";
    (env as any).GEMINI_API_KEY = "gk";
    (env as any).GCS_SERVICE_ACCOUNT_JSON = "{}";
    (env as any).GCS_BUCKET = "b";
    (env as any).IDO_INBOX_CHAT_ID = "-100";
    (env as any).GITHUB_APP_ID = "12345";
    (env as any).GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";
    await putClient(env as any, 50, {
      name: "Yossi", telegram_chat_id: 50,
      active: true, created_at: "2026-04-29T00:00:00Z",
      projects: [{ id: "acme-core", name_he: "acme-core", repo: "x/acme-core", created_at: "2026-04-29T00:00:00Z" }],
      active_project_id: "acme-core", default_project_id: "acme-core",
    });
    await putClient(env as any, 51, {
      name: "Inactive", telegram_chat_id: 51,
      active: false, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "old", name_he: "old", repo: "x/old", created_at: "2026-01-01T00:00:00Z" }],
      active_project_id: "old", default_project_id: "old",
    });
    // Pre-seed repo context so the classifier path doesn't hit GitHub.
    await putRepoContext(env as any, "x/acme-core", {
      tree: "src/", readme: "R", recent_issues: [], fetched_at: "t",
    });
  });

  it("returns 401 on bad signature", async () => {
    const req = withSecret(makeUpdate(50, "hi"), "wrong");
    const { tg } = makeFakeTg();
    const res = await handleTelegramWebhook(req, env as any, { tgFactory: () => tg as any });
    expect(res.status).toBe(401);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("returns 200 with 'unknown' branch reply when sender not whitelisted", async () => {
    const req = withSecret(makeUpdate(999, "hi"), SECRET);
    const { tg, sent } = makeFakeTg();
    const res = await handleTelegramWebhook(req, env as any, { tgFactory: () => tg as any });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.action).toBe("rejected_unknown_sender");
    expect(sent.length).toBe(1);
    expect(sent[0]![0]).toBe(999);
  });

  it("rejects an inactive client without sending a Hebrew rejection DM", async () => {
    const req = withSecret(makeUpdate(51, "hi"), SECRET);
    const { tg } = makeFakeTg();
    const res = await handleTelegramWebhook(req, env as any, { tgFactory: () => tg as any });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.action).toBe("rejected_inactive_client");
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores updates that don't parse to a supported message", async () => {
    const req = withSecret({ update_id: 1 }, SECRET);
    const { tg } = makeFakeTg();
    const res = await handleTelegramWebhook(req, env as any, { tgFactory: () => tg as any });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.action).toBe("ignored_unsupported_update");
  });

  it("accepts an active client and reaches the classifier branch (chitchat → skipped)", async () => {
    const req = withSecret(makeUpdate(50, "hi"), SECRET);
    const { tg } = makeFakeTg();
    const res = await handleTelegramWebhook(req, env as any, {
      tgFactory: () => tg as any,
      ghFactory: () => fakeGh() as any,
      classify: (async () => ({ kind: "final" as const, output: chitchatOutput, usage: { input_tokens: 1, output_tokens: 1 } })) as any,
      writeIssue: (async () => ({ kind: "skipped" as const })) as any,
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.action).toBe("skipped");
    expect(tg.react).toHaveBeenCalled();
  });

  it("rate-limits the active client after 30 messages in the same hour", async () => {
    const { tg } = makeFakeTg();
    const deps = {
      tgFactory: () => tg as any,
      ghFactory: () => fakeGh() as any,
      classify: (async () => ({ kind: "final" as const, output: chitchatOutput, usage: { input_tokens: 1, output_tokens: 1 } })) as any,
      writeIssue: (async () => ({ kind: "skipped" as const })) as any,
    };
    for (let i = 0; i < 30; i++) {
      const req = withSecret(makeUpdate(50, `msg ${i}`), SECRET);
      await handleTelegramWebhook(req, env as any, deps);
    }
    const req = withSecret(makeUpdate(50, "msg 31"), SECRET);
    const res = await handleTelegramWebhook(req, env as any, deps);
    const body = await res.json<any>();
    expect(body.action).toBe("rate_limited");
    expect(body.reason).toBe("hourly_message_cap");
  });
});

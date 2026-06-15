import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleTelegramWebhook } from "../../src/handlers/telegram";
import { putClient, putRepoContext, getRecentClassifications } from "../../src/lib/kv";

const SECRET = "tg-secret";

beforeEach(async () => {
  (env as any).TELEGRAM_WEBHOOK_SECRET = SECRET;
  (env as any).TELEGRAM_BOT_TOKEN = "bot-token";
  (env as any).ANTHROPIC_API_KEY = "ak";
  (env as any).GEMINI_API_KEY = "gk";
  (env as any).GCS_SERVICE_ACCOUNT_JSON = "{}";
  (env as any).GCS_BUCKET = "bucket";
  (env as any).IDO_INBOX_CHAT_ID = "-100";
  (env as any).GITHUB_APP_ID = "12345";
  (env as any).GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";
  await putClient(env as any, 50, {
    name: "Yossi", telegram_chat_id: 50,
    active: true, created_at: "2026-04-29T00:00:00Z",
    projects: [{ id: "y", name_he: "y", repo: "x/y", created_at: "2026-04-29T00:00:00Z" }],
    active_project_id: "y", default_project_id: "y",
  });
  await putRepoContext(env as any, "x/y", {
    tree: "src/", readme: "R", recent_issues: [], fetched_at: "t",
  });
});

describe("handleTelegramWebhook end-to-end (mocked deps)", () => {
  it("creates an issue when classifier returns should_create_issue=true", async () => {
    const fakeClassifier = vi.fn(async () => ({
      kind: "final" as const,
      output: {
        should_create_issue: true,
        is_followup_to_issue: null,
        type: "bug" as const, severity: "high" as const,
        title_en: "Export broken", body_he: "ב",
        suggested_labels: ["dashboard"], sensitive: false,
        client_reply_he: "תודה!",
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const fakeIssue = vi.fn(async () => ({ kind: "created" as const, number: 1, url: "u" }));
    const tgSent: Array<[number, string]> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => { tgSent.push([chat, text]); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
      getFilePath: vi.fn(),
      downloadFile: vi.fn(),
    };

    const update = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 50, first_name: "Yossi" },
        chat: { id: 50 },
        date: Math.floor(Date.now() / 1000),
        text: "the export button is broken",
      },
    };
    const req = new Request("https://w/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    const res = await handleTelegramWebhook(req, env as any, {
      tgFactory: () => fakeTg as any,
      ghFactory: () => ({ getRepoTree: async () => [], getReadme: async () => "", listRecentIssues: async () => [] } as any),
      classify: fakeClassifier as any,
      writeIssue: fakeIssue as any,
    });

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.action).toBe("created");
    expect(fakeIssue).toHaveBeenCalledOnce();
    const recipients = tgSent.map(([c]) => c);
    expect(recipients).toEqual(expect.arrayContaining([50, -100]));
  });

  it("persists a classification outcome record after creating an issue", async () => {
    const fakeClassifier = vi.fn(async () => ({
      kind: "final" as const,
      output: {
        should_create_issue: true, is_followup_to_issue: null,
        type: "bug" as const, severity: "high" as const,
        title_en: "Export broken", body_he: "ב",
        suggested_labels: ["dashboard"], sensitive: false, client_reply_he: "תודה!",
      },
      usage: { input_tokens: 10000, output_tokens: 1000 },
    }));
    const fakeIssue = vi.fn(async () => ({ kind: "created" as const, number: 77, url: "u" }));
    const fakeTg = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      react: vi.fn(async () => undefined), getFilePath: vi.fn(), downloadFile: vi.fn(),
    };
    const update = {
      update_id: 1,
      message: { message_id: 100, from: { id: 50, first_name: "Yossi" }, chat: { id: 50 }, date: 1, text: "the export button is broken" },
    };
    const req = new Request("https://w/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    await handleTelegramWebhook(req, env as any, {
      tgFactory: () => fakeTg as any,
      ghFactory: () => ({ getRepoTree: async () => [], getReadme: async () => "", listRecentIssues: async () => [] } as any),
      classify: fakeClassifier as any,
      writeIssue: fakeIssue as any,
    });

    const records = await getRecentClassifications(env as any, 10);
    const mine = records.find((r) => r.issue_number === 77);
    expect(mine).toBeDefined();
    expect(mine!.result_kind).toBe("final");
    expect(mine!.type).toBe("bug");
    expect(mine!.should_create_issue).toBe(true);
    expect(mine!.cost_cents).toBeGreaterThan(0); // priced from real token usage
  });

  it("returns asked_clarifying_question when classifier pauses", async () => {
    const fakeTg = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      react: vi.fn(async () => undefined),
      getFilePath: vi.fn(),
      downloadFile: vi.fn(),
    };
    const update = {
      update_id: 1,
      message: {
        message_id: 1, from: { id: 50, first_name: "Y" }, chat: { id: 50 },
        date: 1, text: "ambiguous?",
      },
    };
    const req = new Request("https://w/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    const res = await handleTelegramWebhook(req, env as any, {
      tgFactory: () => fakeTg as any,
      ghFactory: () => ({ getRepoTree: async () => [], getReadme: async () => "", listRecentIssues: async () => [] } as any),
      classify: (async () => ({ kind: "clarify" as const, question_he: "תוכל להבהיר?" })) as any,
    });
    const body = await res.json<any>();
    expect(body.action).toBe("asked_clarifying_question");
    expect(body.question_he).toBe("תוכל להבהיר?");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleTelegramWebhook } from "../../src/handlers/telegram";
import { putClient, putRepoContext } from "../../src/lib/kv";

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
    name: "Yossi", telegram_chat_id: 50, active: true, created_at: "t",
    projects: [{ id: "y", name_he: "y", repo: "x/y", created_at: "t" }],
    active_project_id: "y", default_project_id: "y",
  });
  await putRepoContext(env as any, "x/y", { tree: "src/", readme: "R", recent_issues: [], fetched_at: "t" });
});

describe("processing indicator", () => {
  it("sends 'מעבד...' on the full classifier path, before the classifier runs", async () => {
    const sent: Array<{ chat: number; text: string }> = [];
    const callTimings: Array<{ method: string; index: number }> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => {
        sent.push({ chat, text });
        callTimings.push({ method: "sendMessage", index: callTimings.length });
        return { message_id: callTimings.length };
      }),
      react: vi.fn(async () => undefined),
      getFilePath: vi.fn(),
      downloadFile: vi.fn(),
    };
    const fakeClassifier = vi.fn(async () => {
      callTimings.push({ method: "classify", index: callTimings.length });
      return {
        kind: "final" as const,
        output: {
          should_create_issue: false, is_followup_to_issue: null,
          type: "chitchat" as const, severity: "low" as const,
          title_en: "x", body_he: "x",
          suggested_labels: [], sensitive: false,
          client_reply_he: "תודה",
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });

    const update = {
      update_id: 1,
      message: {
        message_id: 100, from: { id: 50, first_name: "Y" }, chat: { id: 50 },
        date: Math.floor(Date.now() / 1000), text: "the export is broken",
      },
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
    });

    const processingMsg = sent.find((s) => s.chat === 50 && /מעבד/.test(s.text));
    expect(processingMsg).toBeDefined();
    const procIdx = callTimings.findIndex((c) => c.method === "sendMessage");
    const classifyIdx = callTimings.findIndex((c) => c.method === "classify");
    expect(procIdx).toBeGreaterThanOrEqual(0);
    expect(classifyIdx).toBeGreaterThan(procIdx);
  });

  it("does NOT send 'מעבד...' on /start command", async () => {
    const sent: Array<{ chat: number; text: string }> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => { sent.push({ chat, text }); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
    };

    const req = new Request("https://w/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 100, from: { id: 50, first_name: "Y" }, chat: { id: 50 },
          date: Math.floor(Date.now() / 1000), text: "/start",
        },
      }),
    });

    await handleTelegramWebhook(req, env as any, { tgFactory: () => fakeTg as any });

    expect(sent.find((s) => /מעבד/.test(s.text))).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
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
    name: "Yossi", telegram_chat_id: 50, active: true, created_at: "2026-04-29T00:00:00Z",
    projects: [{ id: "y", name_he: "y", repo: "x/y", created_at: "2026-04-29T00:00:00Z" }],
    active_project_id: "y", default_project_id: "y",
  });
  await putRepoContext(env as any, "x/y", { tree: "src/", readme: "R", recent_issues: [], fetched_at: "t" });
});

describe("handleTelegramWebhook on classifier error", () => {
  it("sends a Hebrew apology to the client AND notifies Ido", async () => {
    const sent: Array<{ chat: number; text: string }> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => { sent.push({ chat, text }); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
      getFilePath: vi.fn(),
      downloadFile: vi.fn(),
    };
    const fakeClassifier = vi.fn(async () => ({ kind: "error" as const, message: "JSON parse failed" }));

    const update = {
      update_id: 1,
      message: {
        message_id: 100, from: { id: 50, first_name: "Yossi" }, chat: { id: 50 },
        date: Math.floor(Date.now() / 1000), text: "shoe readme.md file",
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
    });

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.action).toBe("classifier_error");

    // Skip the "מעבד..." processing indicator that fires before the classifier;
    // the apology is the second message to the client.
    const clientMsg = sent.find((s) => s.chat === 50 && /מצטער/.test(s.text));
    expect(clientMsg).toBeDefined();
    expect(clientMsg!.text).toMatch(/מצטער/);

    const idoMsg = sent.find((s) => s.chat === -100);
    expect(idoMsg).toBeDefined();
    expect(idoMsg!.text).toMatch(/Classifier error/);
  });
});

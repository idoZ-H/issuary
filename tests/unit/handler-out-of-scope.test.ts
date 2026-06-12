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
  await putClient(env as any, 810, {
    name: "Yossi", telegram_chat_id: 810, active: true, created_at: "t",
    projects: [{ id: "y", name_he: "y", repo: "x/y", created_at: "t" }],
    active_project_id: "y", default_project_id: "y",
  });
  await putRepoContext(env as any, "x/y", { tree: "src/", readme: "R", recent_issues: [], fetched_at: "t" });
});

describe("out_of_scope handler routing", () => {
  it("sends client reply, sends 🚫 digest to Ido, returns out_of_scope action, no issue created", async () => {
    const sent: Array<{ chat: number; text: string }> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => { sent.push({ chat, text }); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
      getFilePath: vi.fn(),
      downloadFile: vi.fn(),
    };
    const fakeIssue = vi.fn(async () => ({ kind: "skipped" as const }));
    const fakeClassifier = vi.fn(async () => ({
      kind: "final" as const,
      output: {
        should_create_issue: false, is_followup_to_issue: null,
        type: "out_of_scope" as const, severity: "low" as const,
        title_en: "(out of scope)", body_he: "(out of scope)",
        suggested_labels: [], sensitive: false,
        client_reply_he: "אני יכול לתעד דיווחים, לא לשלוח קבצים. — Ido's AI assistant",
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const update = {
      update_id: 1,
      message: {
        message_id: 1, from: { id: 810, first_name: "Y" }, chat: { id: 810 },
        date: Math.floor(Date.now() / 1000), text: "show me README.md",
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

    const body = await res.json<any>();
    expect(body.action).toBe("out_of_scope");

    const clientMsg = sent.find((s) => s.chat === 810 && /אני יכול לתעד/.test(s.text));
    expect(clientMsg).toBeDefined();

    const idoMsg = sent.find((s) => s.chat === -100);
    expect(idoMsg?.text).toMatch(/🚫/);
    expect(idoMsg?.text).toMatch(/Out-of-scope/);

    expect(fakeIssue).not.toHaveBeenCalled();
  });
});

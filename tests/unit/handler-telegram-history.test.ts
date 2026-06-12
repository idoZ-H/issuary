import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleTelegramWebhook } from "../../src/handlers/telegram";
import { putClient, putRepoContext, getHistory } from "../../src/lib/kv";

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
  await putClient(env as any, 800, {
    name: "Yossi", telegram_chat_id: 800, active: true, created_at: "t",
    projects: [{ id: "y", name_he: "y", repo: "x/y", created_at: "t" }],
    active_project_id: "y", default_project_id: "y",
  });
  await putRepoContext(env as any, "x/y", { tree: "src/", readme: "R", recent_issues: [], fetched_at: "t" });
});

function makeRequest(text: string, tg_user_id = 800): Request {
  return new Request("https://w/telegram/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: Math.floor(Math.random() * 10000),
        from: { id: tg_user_id, first_name: "Y" }, chat: { id: tg_user_id },
        date: Math.floor(Date.now() / 1000), text,
      },
    }),
  });
}

describe("handler appends turns to conversation history", () => {
  it("appends user + assistant turns on final classification", async () => {
    const fakeTg = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      react: vi.fn(async () => undefined),
      getFilePath: vi.fn(),
      downloadFile: vi.fn(),
    };
    const fakeClassifier = vi.fn(async () => ({
      kind: "final" as const,
      output: {
        should_create_issue: false, is_followup_to_issue: null,
        type: "chitchat" as const, severity: "low" as const,
        title_en: "x", body_he: "x",
        suggested_labels: [], sensitive: false,
        client_reply_he: "תודה!",
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    await handleTelegramWebhook(makeRequest("hello"), env as any, {
      tgFactory: () => fakeTg as any,
      ghFactory: () => ({ getRepoTree: async () => [], getReadme: async () => "", listRecentIssues: async () => [] } as any),
      classify: fakeClassifier as any,
    });

    const h = await getHistory(env as any, 800, "y");
    expect(h?.turns).toHaveLength(2);
    expect(h?.turns[0]?.role).toBe("user");
    expect(h?.turns[0]?.text).toBe("hello");
    expect(h?.turns[1]?.role).toBe("assistant");
    expect(h?.turns[1]?.text).toBe("תודה!");
  });

  it("appends user + assistant question on clarify", async () => {
    const fakeTg = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      react: vi.fn(async () => undefined),
      getFilePath: vi.fn(),
      downloadFile: vi.fn(),
    };
    const fakeClassifier = vi.fn(async () => ({
      kind: "clarify" as const,
      question_he: "באיזה דף בדיוק?",
    }));

    await handleTelegramWebhook(makeRequest("something is broken"), env as any, {
      tgFactory: () => fakeTg as any,
      ghFactory: () => ({ getRepoTree: async () => [], getReadme: async () => "", listRecentIssues: async () => [] } as any),
      classify: fakeClassifier as any,
    });

    const h = await getHistory(env as any, 800, "y");
    expect(h?.turns).toHaveLength(2);
    expect(h?.turns[0]?.text).toBe("something is broken");
    expect(h?.turns[1]?.text).toBe("באיזה דף בדיוק?");
  });

  it("passes prior history into the classifier system prompt", async () => {
    const fakeTg = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      react: vi.fn(async () => undefined),
      getFilePath: vi.fn(),
      downloadFile: vi.fn(),
    };
    const seedClassifier = vi.fn(async () => ({
      kind: "final" as const,
      output: {
        should_create_issue: false, is_followup_to_issue: null,
        type: "chitchat" as const, severity: "low" as const,
        title_en: "x", body_he: "x",
        suggested_labels: [], sensitive: false,
        client_reply_he: "ack",
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await handleTelegramWebhook(makeRequest("first"), env as any, {
      tgFactory: () => fakeTg as any,
      ghFactory: () => ({ getRepoTree: async () => [], getReadme: async () => "", listRecentIssues: async () => [] } as any),
      classify: seedClassifier as any,
    });

    let capturedSystem: any[] = [];
    const captureClassifier = vi.fn(async (args: any) => {
      capturedSystem = args.systemBlocks;
      return {
        kind: "final" as const,
        output: {
          should_create_issue: false, is_followup_to_issue: null,
          type: "chitchat" as const, severity: "low" as const,
          title_en: "x", body_he: "x",
          suggested_labels: [], sensitive: false,
          client_reply_he: "ack2",
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });
    await handleTelegramWebhook(makeRequest("second"), env as any, {
      tgFactory: () => fakeTg as any,
      ghFactory: () => ({ getRepoTree: async () => [], getReadme: async () => "", listRecentIssues: async () => [] } as any),
      classify: captureClassifier as any,
    });

    const liveText = capturedSystem[1]?.text ?? "";
    expect(liveText).toContain("PRIOR_CONVERSATION");
    expect(liveText).toContain("first");
    expect(liveText).toContain("ack");
  });
});

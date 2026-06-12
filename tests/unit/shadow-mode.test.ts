import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleTelegramWebhook } from "../../src/handlers/telegram";
import { putClient, putRepoContext } from "../../src/lib/kv";

const SECRET = "tg-secret";

beforeEach(async () => {
  (env as any).TELEGRAM_WEBHOOK_SECRET = SECRET;
  (env as any).TELEGRAM_BOT_TOKEN = "t";
  (env as any).ANTHROPIC_API_KEY = "ak";
  (env as any).GEMINI_API_KEY = "gk";
  (env as any).GCS_SERVICE_ACCOUNT_JSON = "{}";
  (env as any).GCS_BUCKET = "b";
  (env as any).IDO_INBOX_CHAT_ID = "-100";
  (env as any).GITHUB_APP_ID = "12345";
  (env as any).GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";
  await putClient(env as any, 50, {
    name: "Yossi", telegram_chat_id: 50,
    active: true, shadow_mode: true, created_at: "2026-04-29T00:00:00Z",
    projects: [{ id: "y", name_he: "y", repo: "x/y", created_at: "2026-04-29T00:00:00Z" }],
    active_project_id: "y", default_project_id: "y",
  });
  await putRepoContext(env as any, "x/y", {
    tree: "src/", readme: "R", recent_issues: [], fetched_at: "t",
  });
});

describe("shadow mode", () => {
  it("posts a shadow digest to the inbox channel before the regular notification", async () => {
    const tgSent: Array<[number, string]> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (c: number, t: string) => { tgSent.push([c, t]); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
      getFilePath: vi.fn(),
      downloadFile: vi.fn(),
    };
    const update = {
      update_id: 1,
      message: {
        message_id: 1, from: { id: 50, first_name: "Y" }, chat: { id: 50 },
        date: Math.floor(Date.now() / 1000), text: "hi",
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
      classify: (async () => ({
        kind: "final" as const,
        output: {
          should_create_issue: false, is_followup_to_issue: null,
          type: "chitchat" as const, severity: "low" as const,
          title_en: "x", body_he: "x", suggested_labels: [], sensitive: false,
          client_reply_he: "שלום!",
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      })) as any,
      writeIssue: (async () => ({ kind: "skipped" as const })) as any,
    });
    const shadowSent = tgSent.find(([_, t]) => t.includes("🪞 <b>Shadow</b>"));
    expect(shadowSent).toBeDefined();
    expect(shadowSent![0]).toBe(-100);
  });
});

describe("semantic_enabled gate", () => {
  const finalChitchat = {
    kind: "final" as const,
    output: {
      should_create_issue: false, is_followup_to_issue: null,
      type: "chitchat" as const, severity: "low" as const,
      title_en: "x", body_he: "x", suggested_labels: [], sensitive: false,
      client_reply_he: "שלום!",
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  const fakeTg = () => ({
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    react: vi.fn(async () => undefined),
    getFilePath: vi.fn(), downloadFile: vi.fn(),
  });
  const fakeGh = () => ({
    getRepoTree: async () => [], getReadme: async () => "", listRecentIssues: async () => [],
    searchCode: async () => ({ matches: [], total: 0, truncated: false }),
    searchIssues: async () => ({ matches: [], total: 0, truncated: false }),
    readFile: async () => ({ path: "", content: "", size_bytes: 0, truncated: false }),
  });
  const makeReq = (userId: number) => new Request("https://w/telegram/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 1,
      message: { message_id: 1, from: { id: userId, first_name: "Y" }, chat: { id: userId }, date: Math.floor(Date.now() / 1000), text: "hi" },
    }),
  });

  async function seed(userId: number, semantic_enabled: boolean) {
    await putClient(env as any, userId, {
      name: "C", telegram_chat_id: userId, active: true, created_at: "2026-04-29T00:00:00Z",
      projects: [{ id: "y", name_he: "y", repo: "x/y", created_at: "2026-04-29T00:00:00Z", semantic_enabled }],
      active_project_id: "y", default_project_id: "y",
    });
    await putRepoContext(env as any, "x/y", { tree: "src/", readme: "R", recent_issues: [], fetched_at: "t" });
  }

  it("wires active semantic retrieval for a non-shadow client with semantic_enabled on", async () => {
    await seed(61, true);
    const retrieve = vi.fn(async () => ({ status: "ok" as const, chunks: [] }));
    await handleTelegramWebhook(makeReq(61), env as any, {
      tgFactory: () => fakeTg() as any,
      ghFactory: () => fakeGh() as any,
      retrieve: retrieve as any,
      classify: (async (a: any) => { await a.dispatcher.dispatch({ name: "github_search_code", input: { query: "find auth" } }); return finalChitchat; }) as any,
      writeIssue: (async () => ({ kind: "skipped" as const })) as any,
    });
    expect(retrieve).toHaveBeenCalledWith(expect.anything(), "x/y", "find auth");
  });

  it("does not wire active retrieval when semantic_enabled is false", async () => {
    await seed(62, false);
    const retrieve = vi.fn(async () => ({ status: "ok" as const, chunks: [] }));
    await handleTelegramWebhook(makeReq(62), env as any, {
      tgFactory: () => fakeTg() as any,
      ghFactory: () => fakeGh() as any,
      retrieve: retrieve as any,
      classify: (async (a: any) => { await a.dispatcher.dispatch({ name: "github_search_code", input: { query: "find auth" } }); return finalChitchat; }) as any,
      writeIssue: (async () => ({ kind: "skipped" as const })) as any,
    });
    expect(retrieve).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
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

describe("silent-failure recovery integration", () => {
  it("classifier returns kind=error → worker returns 200, doesn't leak 500 to Telegram", async () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 100, from: { id: 50, first_name: "Yossi" }, chat: { id: 50 },
        date: Math.floor(Date.now() / 1000), text: "show me README.md",
      },
    };
    const req = new Request("https://w/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    const res = await worker.fetch(req, env as any, { waitUntil: () => {} } as any);
    expect(res.status).toBe(200);
  });

  it("malformed body to /telegram/webhook returns 200, not 500", async () => {
    const req = new Request("https://w/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
      body: "{not-json",
    });
    const res = await worker.fetch(req, env as any, { waitUntil: () => {} } as any);
    expect(res.status).toBe(200);
  });

  it("malformed body to /github/webhook returns 200 or 401, never 500", async () => {
    (env as any).GITHUB_WEBHOOK_SECRET = "gh-secret";
    const req = new Request("https://w/github/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha256=00", "X-GitHub-Event": "issues" },
      body: "{not-json",
    });
    const res = await worker.fetch(req, env as any, { waitUntil: () => {} } as any);
    expect([200, 401]).toContain(res.status);
  });
});

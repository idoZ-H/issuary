import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { putClient } from "../../src/lib/kv";

const SECRET = "tg-secret";

beforeEach(async () => {
  (env as any).TELEGRAM_WEBHOOK_SECRET = SECRET;
  (env as any).TELEGRAM_BOT_TOKEN = "tt";
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
    projects: [{ id: "y", name_he: "y", repo: "x/y", created_at: "2026-04-29T00:00:00Z" }],
    active_project_id: "y", default_project_id: "y",
  });
});

describe("happy-path E2E (Worker boundary)", () => {
  it("rejects unknown sender end-to-end", async () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 1, from: { id: 999, first_name: "Stranger" }, chat: { id: 999 },
        date: Math.floor(Date.now() / 1000), text: "hello",
      },
    };

    // Stub global fetch so the unknown-sender DM doesn't actually hit Telegram.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any) => {
      if (String(input).includes("telegram.org")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      return new Response("", { status: 200 });
    }) as any;

    try {
      const req = new Request("https://w/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      const res = await worker.fetch(req, env as any, {} as any);
      expect(res.status).toBe(200);
      const j = await res.json<any>();
      expect(j.action).toBe("rejected_unknown_sender");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects bad signature at the Worker boundary", async () => {
    const req = new Request("https://w/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).toBe(401);
  });
});

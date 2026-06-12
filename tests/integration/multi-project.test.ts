import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { putClient, getClient } from "../../src/lib/kv";

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
  await putClient(env as any, 200, {
    name: "Yossi", telegram_chat_id: 200, active: true, created_at: "2026-05-08T00:00:00Z",
    projects: [
      { id: "core", name_he: "Project Core", repo: "x/core", created_at: "2026-05-08T00:00:00Z" },
      { id: "mob", name_he: "Project Mobile", repo: "x/mob", created_at: "2026-05-08T00:00:00Z" },
    ],
    active_project_id: "core", default_project_id: "core",
  });
});

function stubTelegramFetch(): { restore: () => void; calls: string[] } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes("telegram.org")) {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    return new Response("", { status: 200 });
  }) as any;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

describe("multi-project E2E (Worker boundary)", () => {
  it("picker tap switches active project end-to-end", async () => {
    const { restore } = stubTelegramFetch();
    try {
      const req = new Request("https://w/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
        body: JSON.stringify({
          update_id: 1,
          callback_query: {
            id: "CBQ", from: { id: 200, first_name: "Yossi" },
            message: { message_id: 99, chat: { id: 200 } },
            data: "use:mob",
          },
        }),
      });
      const res = await worker.fetch(req, env as any, {} as any);
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.action).toBe("project_switched");
      expect(body.project_id).toBe("mob");

      const c = await getClient(env as any, 200);
      expect(c?.active_project_id).toBe("mob");
    } finally {
      restore();
    }
  });

  it("/use <id> end-to-end switches active project and replies", async () => {
    const { restore } = stubTelegramFetch();
    try {
      const req = new Request("https://w/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
        body: JSON.stringify({
          update_id: 2,
          message: {
            message_id: 5, from: { id: 200, first_name: "Yossi" }, chat: { id: 200 },
            date: Math.floor(Date.now() / 1000), text: "/use mob",
          },
        }),
      });
      const res = await worker.fetch(req, env as any, {} as any);
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.action).toBe("project_switched_via_use");

      const c = await getClient(env as any, 200);
      expect(c?.active_project_id).toBe("mob");
    } finally {
      restore();
    }
  });

  it("/projects shows the picker end-to-end", async () => {
    const { restore } = stubTelegramFetch();
    try {
      const req = new Request("https://w/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
        body: JSON.stringify({
          update_id: 3,
          message: {
            message_id: 6, from: { id: 200, first_name: "Yossi" }, chat: { id: 200 },
            date: Math.floor(Date.now() / 1000), text: "/projects",
          },
        }),
      });
      const res = await worker.fetch(req, env as any, {} as any);
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.action).toBe("shown_picker");
    } finally {
      restore();
    }
  });

  it("rejects callback_query from a non-client end-to-end", async () => {
    const { restore } = stubTelegramFetch();
    try {
      const req = new Request("https://w/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
        body: JSON.stringify({
          update_id: 4,
          callback_query: {
            id: "CBQ2", from: { id: 999, first_name: "Stranger" },
            message: { message_id: 1, chat: { id: 999 } },
            data: "use:core",
          },
        }),
      });
      const res = await worker.fetch(req, env as any, {} as any);
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.action).toBe("rejected_unknown_sender");
    } finally {
      restore();
    }
  });

  it("/use on a single-project client is a no-op end-to-end", async () => {
    // Seed a separate single-project client.
    await (env as any).CLIENTS.put("70", JSON.stringify({
      name: "Avi", telegram_chat_id: 70, active: true, created_at: "2026-05-08T00:00:00Z",
      projects: [{ id: "acme", name_he: "ACME", repo: "x/acme", created_at: "2026-05-08T00:00:00Z" }],
      active_project_id: "acme", default_project_id: "acme",
    }));
    const { restore } = stubTelegramFetch();
    try {
      const req = new Request("https://w/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
        body: JSON.stringify({
          update_id: 5,
          message: {
            message_id: 7, from: { id: 70, first_name: "Avi" }, chat: { id: 70 },
            date: Math.floor(Date.now() / 1000), text: "/use acme",
          },
        }),
      });
      const res = await worker.fetch(req, env as any, {} as any);
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.action).toBe("single_project_no_op");
    } finally {
      restore();
    }
  });
});

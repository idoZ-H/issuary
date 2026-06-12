import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleTelegramWebhook } from "../../src/handlers/telegram";
import { putClient } from "../../src/lib/kv";

const SECRET = "tg-secret";

function makeUpdate(text: string, fromId: number): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      message_id: 1, from: { id: fromId, first_name: "Y" }, chat: { id: fromId },
      date: Math.floor(Date.now() / 1000), text,
    },
  };
}

function makeRequest(update: object): Request {
  return new Request("https://w/telegram/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
    body: JSON.stringify(update),
  });
}

beforeEach(async () => {
  (env as any).TELEGRAM_WEBHOOK_SECRET = SECRET;
  (env as any).TELEGRAM_BOT_TOKEN = "bot-token";
  (env as any).IDO_INBOX_CHAT_ID = "-100";
});

describe("/start", () => {
  it("replies with 'registered only' to unregistered user", async () => {
    const sent: Array<{ chat: number; text: string }> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => { sent.push({ chat, text }); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
    };
    const res = await handleTelegramWebhook(makeRequest(makeUpdate("/start", 999)), env as any, {
      tgFactory: () => fakeTg as any,
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.action).toBe("start_unregistered");
    expect(sent[0]?.text).toMatch(/לקוחות רשומים/);
  });

  it("replies with welcome to registered single-project user", async () => {
    await putClient(env as any, 100, {
      name: "Yossi", telegram_chat_id: 100, active: true, created_at: "t",
      projects: [{ id: "a", name_he: "פרויקט א", repo: "x/a", created_at: "t" }],
      active_project_id: "a", default_project_id: "a",
    });
    const sent: Array<{ chat: number; text: string }> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => { sent.push({ chat, text }); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
    };
    const res = await handleTelegramWebhook(makeRequest(makeUpdate("/start", 100)), env as any, {
      tgFactory: () => fakeTg as any,
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.action).toBe("start_registered");
    expect(sent[0]?.text).toMatch(/שלום Yossi/);
    expect(sent[0]?.text).toMatch(/לתעד/);
    expect(sent[0]?.text).toMatch(/לא יכול/);
    expect(sent[0]?.text).not.toMatch(/הפרויקטים שלך/);
  });

  it("replies with welcome + project list to multi-project user", async () => {
    await putClient(env as any, 101, {
      name: "Eve", telegram_chat_id: 101, active: true, created_at: "t",
      projects: [
        { id: "a", name_he: "פרויקט א", repo: "x/a", created_at: "t" },
        { id: "b", name_he: "פרויקט ב", repo: "x/b", created_at: "t" },
      ],
      active_project_id: "a", default_project_id: "a",
    });
    const sent: Array<{ chat: number; text: string }> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => { sent.push({ chat, text }); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
    };
    const res = await handleTelegramWebhook(makeRequest(makeUpdate("/start", 101)), env as any, {
      tgFactory: () => fakeTg as any,
    });
    const body = await res.json<any>();
    expect(body.action).toBe("start_registered");
    expect(sent[0]?.text).toMatch(/שלום Eve/);
    expect(sent[0]?.text).toMatch(/לתעד/);
    expect(sent[0]?.text).toMatch(/לא יכול/);
    expect(sent[0]?.text).toMatch(/הפרויקטים שלך/);
    expect(sent[0]?.text).toMatch(/פרויקט א/);
    expect(sent[0]?.text).toMatch(/פרויקט ב/);
  });

  it("returns start_inactive for inactive users without sending a message", async () => {
    await putClient(env as any, 102, {
      name: "Z", telegram_chat_id: 102, active: false, created_at: "t",
      projects: [{ id: "a", name_he: "א", repo: "x/a", created_at: "t" }],
      active_project_id: "a", default_project_id: "a",
    });
    const fakeTg = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      react: vi.fn(async () => undefined),
    };
    const res = await handleTelegramWebhook(makeRequest(makeUpdate("/start", 102)), env as any, {
      tgFactory: () => fakeTg as any,
    });
    const body = await res.json<any>();
    expect(body.action).toBe("start_inactive");
    expect(fakeTg.sendMessage).not.toHaveBeenCalled();
  });
});

describe("/help", () => {
  it("replies with 'registered only' to unregistered user", async () => {
    const sent: Array<{ chat: number; text: string }> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => { sent.push({ chat, text }); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
    };
    const res = await handleTelegramWebhook(makeRequest(makeUpdate("/help", 998)), env as any, {
      tgFactory: () => fakeTg as any,
    });
    const body = await res.json<any>();
    expect(body.action).toBe("help_unregistered");
    expect(sent[0]?.text).toMatch(/לקוחות רשומים/);
  });

  it("replies with single-project help to registered single-project user", async () => {
    await putClient(env as any, 103, {
      name: "S", telegram_chat_id: 103, active: true, created_at: "t",
      projects: [{ id: "a", name_he: "א", repo: "x/a", created_at: "t" }],
      active_project_id: "a", default_project_id: "a",
    });
    const sent: Array<{ chat: number; text: string }> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => { sent.push({ chat, text }); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
    };
    const res = await handleTelegramWebhook(makeRequest(makeUpdate("/help", 103)), env as any, {
      tgFactory: () => fakeTg as any,
    });
    const body = await res.json<any>();
    expect(body.action).toBe("help_registered");
    expect(sent[0]?.text).toMatch(/מה אני יכול/);
    expect(sent[0]?.text).toMatch(/מה אני לא יכול/);
    expect(sent[0]?.text).not.toMatch(/\/use/);
    expect(sent[0]?.text).toMatch(/\/help/);
  });

  it("replies with multi-project help (mentions /use) to multi-project user", async () => {
    await putClient(env as any, 104, {
      name: "M", telegram_chat_id: 104, active: true, created_at: "t",
      projects: [
        { id: "a", name_he: "א", repo: "x/a", created_at: "t" },
        { id: "b", name_he: "ב", repo: "x/b", created_at: "t" },
      ],
      active_project_id: "a", default_project_id: "a",
    });
    const sent: Array<{ chat: number; text: string }> = [];
    const fakeTg = {
      sendMessage: vi.fn(async (chat: number, text: string) => { sent.push({ chat, text }); return { message_id: 1 }; }),
      react: vi.fn(async () => undefined),
    };
    const res = await handleTelegramWebhook(makeRequest(makeUpdate("/help", 104)), env as any, {
      tgFactory: () => fakeTg as any,
    });
    const body = await res.json<any>();
    expect(body.action).toBe("help_registered");
    expect(sent[0]?.text).toMatch(/מה אני יכול/);
    expect(sent[0]?.text).toMatch(/מה אני לא יכול/);
    expect(sent[0]?.text).toMatch(/\/use/);
    expect(sent[0]?.text).toMatch(/\/projects/);
  });
});

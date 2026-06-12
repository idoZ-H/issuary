import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleTelegramWebhook } from "../../src/handlers/telegram";
import { putClient } from "../../src/lib/kv";

const SECRET = "tg-secret";

beforeEach(async () => {
  (env as any).TELEGRAM_WEBHOOK_SECRET = SECRET;
  (env as any).TELEGRAM_BOT_TOKEN = "bot-token";
  (env as any).IDO_INBOX_CHAT_ID = "-100";
  await putClient(env as any, 50, {
    name: "Yossi", telegram_chat_id: 50, active: true, created_at: "t",
    projects: [
      { id: "a", name_he: "א", repo: "x/a", created_at: "t" },
      { id: "b", name_he: "ב", repo: "x/b", created_at: "t" },
    ],
    active_project_id: "a", default_project_id: "a",
  });
});

describe("picker cancel callback", () => {
  it("clears the inline keyboard and acks with בוטל", async () => {
    const editKb = vi.fn(async () => undefined);
    const ackCb = vi.fn(async () => undefined);
    const fakeTg = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      react: vi.fn(async () => undefined),
      editMessageReplyMarkup: editKb,
      answerCallbackQuery: ackCb,
    };

    const update = {
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: 50, first_name: "Y" },
        message: { message_id: 99, chat: { id: 50 } },
        data: "use:_cancel",
      },
    };
    const req = new Request("https://w/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    const res = await handleTelegramWebhook(req, env as any, {
      tgFactory: () => fakeTg as any,
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.action).toBe("picker_cancelled");
    expect(editKb).toHaveBeenCalledWith(50, 99);
    expect(ackCb).toHaveBeenCalledWith("cb-1", expect.objectContaining({ text: expect.stringMatching(/בוטל/) }));
  });
});

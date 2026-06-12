import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleTelegramWebhook } from "../../src/handlers/telegram";

const SECRET = "tg-secret";

beforeEach(() => {
  (env as any).TELEGRAM_WEBHOOK_SECRET = SECRET;
  (env as any).TELEGRAM_BOT_TOKEN = "bot-token";
});

describe("unsupported message types handler", () => {
  const cases: Array<[string, string, string]> = [
    ["sticker", '"sticker": {"file_id": "x"}', "מדבקה"],
    ["video_note", '"video_note": {"file_id": "x"}', "סרטון מעגלי"],
    ["location", '"location": {"latitude": 1, "longitude": 2}', "מיקום"],
    ["poll", '"poll": {"id": "x"}', "סקר"],
    ["contact", '"contact": {"phone_number": "1"}', "איש קשר"],
    ["animation", '"animation": {"file_id": "x"}', "GIF"],
  ];

  for (const [type, fragment, hebrewName] of cases) {
    it(`replies in Hebrew when client sends a ${type}`, async () => {
      const sent: Array<{ chat: number; text: string }> = [];
      const fakeTg = {
        sendMessage: vi.fn(async (chat: number, text: string) => { sent.push({ chat, text }); return { message_id: 1 }; }),
        react: vi.fn(async () => undefined),
      };
      const body = `{
        "update_id": 1,
        "message": {
          "message_id": 1,
          "from": { "id": 50, "first_name": "Y" },
          "chat": { "id": 50 },
          "date": 1,
          ${fragment}
        }
      }`;
      const req = new Request("https://w/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
        body,
      });
      const res = await handleTelegramWebhook(req, env as any, { tgFactory: () => fakeTg as any });
      const respBody = await res.json<any>();
      expect(respBody.action).toBe("ignored_unsupported_type");
      expect(respBody.type).toBe(type);
      expect(sent[0]?.text).toContain(hebrewName);
    });
  }
});

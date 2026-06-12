import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleTelegramWebhook } from "../../src/handlers/telegram";
import { putAdmin, putClient, getClient, putPending, getPending } from "../../src/lib/kv";

const SECRET = "tg-secret-multi";

beforeEach(async () => {
  (env as any).TELEGRAM_WEBHOOK_SECRET = SECRET;
  (env as any).TELEGRAM_BOT_TOKEN = "test-token";
  (env as any).IDO_INBOX_CHAT_ID = "-100";
  await putAdmin(env as any, 1);
  await putClient(env as any, 200, {
    name: "Yossi", telegram_chat_id: 200, active: true, created_at: "2026-05-08T00:00:00Z",
    projects: [
      { id: "a", name_he: "Project A", repo: "x/a", created_at: "x" },
      { id: "b", name_he: "Project B", repo: "x/b", created_at: "x" },
    ],
    active_project_id: "a", default_project_id: "a",
  });
});

function fakeRequest(body: any): Request {
  return new Request("https://example.com/telegram/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("multi-project picker callback", () => {
  it("switches active project on tap and acks via answerCallbackQuery", async () => {
    const calls: any[] = [];
    const tgFactory = () => ({
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      sendMessageWithKeyboard: vi.fn(async () => ({ message_id: 1 })),
      editMessageReplyMarkup: vi.fn(async (...a: any[]) => calls.push(["editMessageReplyMarkup", a])),
      answerCallbackQuery: vi.fn(async (...a: any[]) => calls.push(["answerCallbackQuery", a])),
      setMyCommands: vi.fn(async () => {}),
      react: vi.fn(async () => {}),
    });

    const res = await handleTelegramWebhook(
      fakeRequest({
        callback_query: {
          id: "CBQ", from: { id: 200, first_name: "Yossi" },
          message: { message_id: 99, chat: { id: 200 } },
          data: "use:b",
        },
      }),
      env as any,
      { tgFactory: tgFactory as any },
    );
    const body = await res.json() as any;
    expect(body.action).toBe("project_switched");
    expect(body.project_id).toBe("b");

    const c = await getClient(env as any, 200);
    expect(c?.active_project_id).toBe("b");

    expect(calls.find((c) => c[0] === "answerCallbackQuery")).toBeDefined();
    expect(calls.find((c) => c[0] === "editMessageReplyMarkup")).toBeDefined();
  });

  it("rejects callback_query from a non-client", async () => {
    const tgFactory = () => ({
      answerCallbackQuery: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    });
    const res = await handleTelegramWebhook(
      fakeRequest({
        callback_query: {
          id: "CBQ2", from: { id: 999, first_name: "Stranger" },
          message: { message_id: 1, chat: { id: 999 } },
          data: "use:b",
        },
      }),
      env as any,
      { tgFactory: tgFactory as any },
    );
    expect((await res.json() as any).action).toBe("rejected_unknown_sender");
  });

  it("rejects callback_query for a project the client no longer has", async () => {
    const ack = vi.fn(async () => {});
    const tgFactory = () => ({
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      answerCallbackQuery: ack,
    });
    await handleTelegramWebhook(
      fakeRequest({
        callback_query: {
          id: "CBQ3", from: { id: 200, first_name: "Yossi" },
          message: { message_id: 99, chat: { id: 200 } },
          data: "use:gone",
        },
      }),
      env as any,
      { tgFactory: tgFactory as any },
    );
    expect(ack).toHaveBeenCalled();
    const args = (ack.mock.calls[0]) as any[];
    expect(args[1].show_alert).toBe(true);
  });
});

describe("/use and /projects", () => {
  it("/use <project_id> switches active and acks", async () => {
    const sentTexts: string[] = [];
    const tgFactory = () => ({
      sendMessage: vi.fn(async (_c: number, t: string) => { sentTexts.push(t); return { message_id: 1 }; }),
      sendMessageWithKeyboard: vi.fn(async () => ({ message_id: 1 })),
      react: vi.fn(async () => {}),
      setMyCommands: vi.fn(async () => {}),
    });
    const res = await handleTelegramWebhook(
      fakeRequest({
        message: {
          message_id: 1, from: { id: 200, first_name: "Yossi" }, chat: { id: 200 },
          text: "/use b",
        },
      }),
      env as any,
      { tgFactory: tgFactory as any },
    );
    expect((await res.json() as any).action).toBe("project_switched_via_use");
    const c = await getClient(env as any, 200);
    expect(c?.active_project_id).toBe("b");
    expect(sentTexts.some((t) => /Project B/i.test(t))).toBe(true);
  });

  it("/use unknown_id replies with hint and current list", async () => {
    const sentTexts: string[] = [];
    const tgFactory = () => ({
      sendMessage: vi.fn(async (_c: number, t: string) => { sentTexts.push(t); return { message_id: 1 }; }),
      sendMessageWithKeyboard: vi.fn(async (_c: number, t: string) => { sentTexts.push(t); return { message_id: 1 }; }),
      react: vi.fn(async () => {}),
    });
    await handleTelegramWebhook(
      fakeRequest({
        message: {
          message_id: 1, from: { id: 200, first_name: "Yossi" }, chat: { id: 200 },
          text: "/use unknown",
        },
      }),
      env as any,
      { tgFactory: tgFactory as any },
    );
    expect(sentTexts.some((t) => /לא נמצא|not found/i.test(t))).toBe(true);
  });

  it("/projects shows the picker", async () => {
    const sentKeyboards: any[] = [];
    const tgFactory = () => ({
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      sendMessageWithKeyboard: vi.fn(async (_c: number, _t: string, kb: any) => { sentKeyboards.push(kb); return { message_id: 1 }; }),
      react: vi.fn(async () => {}),
    });
    await handleTelegramWebhook(
      fakeRequest({
        message: {
          message_id: 1, from: { id: 200, first_name: "Yossi" }, chat: { id: 200 },
          text: "/projects",
        },
      }),
      env as any,
      { tgFactory: tgFactory as any },
    );
    expect(sentKeyboards.length).toBe(1);
    // 2 project rows + 1 cancel row
    expect(sentKeyboards[0].flat().length).toBe(3);
    expect(sentKeyboards[0][sentKeyboards[0].length - 1][0].callback_data).toBe("use:_cancel");
  });
});

describe("switch cancels pending classification", () => {
  it("/use cancels pending on the old project and warns the client", async () => {
    const sentTexts: string[] = [];
    const tgFactory = () => ({
      sendMessage: vi.fn(async (_c: number, t: string) => { sentTexts.push(t); return { message_id: 1 }; }),
      sendMessageWithKeyboard: vi.fn(async () => ({ message_id: 1 })),
      react: vi.fn(async () => {}),
      setMyCommands: vi.fn(async () => {}),
    });

    // Seed a pending classification on the current active project ("a") for user 200.
    await putPending(env as any, 200, "a", {
      raw_message_id: 1, raw_message_text: "test", attachments: [],
      asked_question_he: "?", asked_at: "2026-05-08T00:00:00Z",
    });

    await handleTelegramWebhook(
      fakeRequest({
        message: {
          message_id: 2, from: { id: 200, first_name: "Yossi" }, chat: { id: 200 },
          text: "/use b",
        },
      }),
      env as any,
      { tgFactory: tgFactory as any },
    );

    // Pending on "a" should be gone.
    expect(await getPending(env as any, 200, "a")).toBeNull();
    // Client should have received a warning mentioning the cancellation.
    expect(sentTexts.some((t) => /ביטלתי את השאלה/.test(t))).toBe(true);
  });

  it("picker tap also cancels pending on the old project", async () => {
    const sentTexts: string[] = [];
    const tgFactory = () => ({
      sendMessage: vi.fn(async (_c: number, t: string) => { sentTexts.push(t); return { message_id: 1 }; }),
      editMessageReplyMarkup: vi.fn(async () => {}),
      answerCallbackQuery: vi.fn(async () => {}),
      setMyCommands: vi.fn(async () => {}),
      react: vi.fn(async () => {}),
    });

    await putPending(env as any, 200, "a", {
      raw_message_id: 1, raw_message_text: "test", attachments: [],
      asked_question_he: "?", asked_at: "2026-05-08T00:00:00Z",
    });

    await handleTelegramWebhook(
      fakeRequest({
        callback_query: {
          id: "CBQX", from: { id: 200, first_name: "Yossi" },
          message: { message_id: 99, chat: { id: 200 } },
          data: "use:b",
        },
      }),
      env as any,
      { tgFactory: tgFactory as any },
    );

    expect(await getPending(env as any, 200, "a")).toBeNull();
    expect(sentTexts.some((t) => /ביטלתי את השאלה/.test(t))).toBe(true);
  });
});

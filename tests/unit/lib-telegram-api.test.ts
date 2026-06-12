import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramClient } from "../../src/lib/telegram";

describe("TelegramClient", () => {
  let calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
      headers: { "content-type": "application/json" },
    });
  });

  beforeEach(() => { calls = []; fakeFetch.mockClear(); });

  it("sends a text message with no parse_mode by default", async () => {
    const tg = new TelegramClient("BOT_TOKEN", fakeFetch as unknown as typeof fetch);
    await tg.sendMessage(123, "hello");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/botBOT_TOKEN/sendMessage");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ chat_id: 123, text: "hello" });
  });

  it("opts into Markdown when parseMode is set", async () => {
    const tg = new TelegramClient("T", fakeFetch as unknown as typeof fetch);
    await tg.sendMessage(1, "*bold*", { parseMode: "Markdown" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.parse_mode).toBe("Markdown");
  });

  it("includes reply_to_message_id when provided", async () => {
    const tg = new TelegramClient("T", fakeFetch as unknown as typeof fetch);
    await tg.sendMessage(1, "x", 42);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.reply_to_message_id).toBe(42);
  });

  it("posts a reaction", async () => {
    const tg = new TelegramClient("T", fakeFetch as unknown as typeof fetch);
    await tg.react(456, 789, "👀");
    expect(calls[0]!.url).toContain("/setMessageReaction");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ chat_id: 456, message_id: 789 });
    expect(body.reaction[0]).toMatchObject({ type: "emoji", emoji: "👀" });
  });

  it("returns the file_path from getFile", async () => {
    fakeFetch.mockImplementationOnce(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/abc.jpg" } }));
    });
    const tg = new TelegramClient("T", fakeFetch as unknown as typeof fetch);
    const path = await tg.getFilePath("file_id_xyz");
    expect(path).toBe("photos/abc.jpg");
    expect(calls[0]!.url).toContain("/getFile");
  });

  it("downloadFile fetches the binary file URL with the bot token", async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    fakeFetch.mockImplementationOnce(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(buf);
    });
    const tg = new TelegramClient("TOK", fakeFetch as unknown as typeof fetch);
    const out = await tg.downloadFile("photos/abc.jpg");
    expect(calls[0]!.url).toBe("https://api.telegram.org/file/botTOK/photos/abc.jpg");
    expect(new Uint8Array(out)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("throws when sendMessage response has ok=false", async () => {
    fakeFetch.mockImplementationOnce(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ ok: false, description: "blocked" }));
    });
    const tg = new TelegramClient("T", fakeFetch as unknown as typeof fetch);
    await expect(tg.sendMessage(1, "x")).rejects.toThrow(/blocked/);
  });
});

describe("TelegramClient new helpers", () => {
  it("setMyCommands posts the right body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true })));
    const tg = new TelegramClient("TOKEN", fetchMock as any);
    await tg.setMyCommands([{ command: "start", description: "התחל" }], {
      scope: { type: "chat", chat_id: 100 }, language_code: "he",
    });
    expect(fetchMock).toHaveBeenCalled();
    const [, init] = (fetchMock.mock.calls as any[])[0]!;
    const body = JSON.parse((init as any).body);
    expect(body.commands[0].command).toBe("start");
    expect(body.scope.chat_id).toBe(100);
    expect(body.language_code).toBe("he");
  });

  it("answerCallbackQuery posts callback_query_id and text", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true })));
    const tg = new TelegramClient("TOKEN", fetchMock as any);
    await tg.answerCallbackQuery("CBQID", { text: "ok" });
    const [, init] = (fetchMock.mock.calls as any[])[0]!;
    const body = JSON.parse((init as any).body);
    expect(body.callback_query_id).toBe("CBQID");
    expect(body.text).toBe("ok");
  });

  it("editMessageReplyMarkup with no reply_markup clears the keyboard", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })));
    const tg = new TelegramClient("TOKEN", fetchMock as any);
    await tg.editMessageReplyMarkup(100, 5);
    const [, init] = (fetchMock.mock.calls as any[])[0]!;
    const body = JSON.parse((init as any).body);
    expect(body.chat_id).toBe(100);
    expect(body.message_id).toBe(5);
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("sendMessage with inline keyboard attaches reply_markup", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })));
    const tg = new TelegramClient("TOKEN", fetchMock as any);
    await tg.sendMessageWithKeyboard(100, "pick:", [
      [{ text: "A", callback_data: "use:a" }],
      [{ text: "B", callback_data: "use:b" }],
    ]);
    const [, init] = (fetchMock.mock.calls as any[])[0]!;
    const body = JSON.parse((init as any).body);
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);
  });
});

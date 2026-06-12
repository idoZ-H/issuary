import { describe, it, expect } from "vitest";
import { parseTelegramUpdate } from "../../src/lib/telegram-update";

describe("parseTelegramUpdate", () => {
  it("extracts a text message", () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 42, first_name: "Yossi" },
        chat: { id: 42 },
        date: 1700000000,
        text: "hello",
      },
    };
    const r = parseTelegramUpdate(update);
    expect(r).toEqual({
      kind: "message",
      tg_user_id: 42,
      chat_id: 42,
      message_id: 100,
      text: "hello",
      attachments: [],
      first_name: "Yossi",
    });
  });

  it("extracts a photo with optional caption and picks the largest size", () => {
    const update = {
      update_id: 2,
      message: {
        message_id: 101,
        from: { id: 42, first_name: "Yossi" },
        chat: { id: 42 },
        date: 1700000000,
        caption: "broken!",
        photo: [
          { file_id: "small", file_size: 1000, width: 100, height: 100 },
          { file_id: "best", file_size: 5000, width: 1000, height: 800 },
        ],
      },
    };
    const r = parseTelegramUpdate(update);
    expect(r?.kind).toBe("message");
    if (r?.kind === "message") {
      expect(r.text).toBe("broken!");
      expect(r.attachments).toEqual([
        { kind: "photo", telegram_file_id: "best", size_bytes: 5000 },
      ]);
    }
  });

  it("extracts a voice message", () => {
    const update = {
      update_id: 3,
      message: {
        message_id: 102,
        from: { id: 42, first_name: "Y" },
        chat: { id: 42 },
        date: 1700000000,
        voice: { file_id: "voice_xyz", duration: 5, mime_type: "audio/ogg", file_size: 2000 },
      },
    };
    const r = parseTelegramUpdate(update);
    if (r?.kind === "message") {
      expect(r.attachments[0]).toEqual({ kind: "voice", telegram_file_id: "voice_xyz", size_bytes: 2000 });
    }
  });

  it("extracts a video and a document", () => {
    const r1 = parseTelegramUpdate({
      update_id: 5,
      message: {
        message_id: 103,
        from: { id: 1, first_name: "Y" },
        chat: { id: 1 },
        date: 1,
        video: { file_id: "vid1", file_size: 9000 },
      },
    });
    expect(r1?.kind === "message" && r1.attachments[0]).toEqual({
      kind: "video", telegram_file_id: "vid1", size_bytes: 9000,
    });

    const r2 = parseTelegramUpdate({
      update_id: 6,
      message: {
        message_id: 104,
        from: { id: 1, first_name: "Y" },
        chat: { id: 1 },
        date: 1,
        document: { file_id: "doc1", file_size: 1234 },
      },
    });
    expect(r2?.kind === "message" && r2.attachments[0]).toEqual({
      kind: "document", telegram_file_id: "doc1", size_bytes: 1234,
    });
  });

  it("falls back to 'client' when first_name is missing", () => {
    const r = parseTelegramUpdate({
      update_id: 7,
      message: {
        message_id: 1,
        from: { id: 9 },
        chat: { id: 9 },
        date: 1,
        text: "hi",
      },
    });
    if (r?.kind === "message") expect(r.first_name).toBe("client");
  });

  it("returns null for unsupported updates (no message)", () => {
    expect(parseTelegramUpdate({ update_id: 4 })).toBeNull();
  });

  it("returns null when message has neither text nor attachments", () => {
    const r = parseTelegramUpdate({
      update_id: 8,
      message: {
        message_id: 1,
        from: { id: 1, first_name: "Y" },
        chat: { id: 1 },
        date: 1,
      },
    });
    expect(r).toBeNull();
  });
});

describe("parseTelegramUpdate unsupported types", () => {
  it("detects sticker and returns kind=unsupported", () => {
    const r = parseTelegramUpdate({
      message: {
        message_id: 1, from: { id: 5 }, chat: { id: 5 },
        sticker: { file_id: "s1" },
      },
    });
    expect(r?.kind).toBe("unsupported");
    if (r?.kind === "unsupported") expect(r.unsupported_type).toBe("sticker");
  });

  it("detects video_note", () => {
    const r = parseTelegramUpdate({
      message: { message_id: 1, from: { id: 5 }, chat: { id: 5 }, video_note: { file_id: "vn1" } },
    });
    expect(r?.kind === "unsupported" && r.unsupported_type).toBe("video_note");
  });

  it("detects location", () => {
    const r = parseTelegramUpdate({
      message: { message_id: 1, from: { id: 5 }, chat: { id: 5 }, location: { latitude: 0, longitude: 0 } },
    });
    expect(r?.kind === "unsupported" && r.unsupported_type).toBe("location");
  });

  it("detects poll", () => {
    const r = parseTelegramUpdate({
      message: { message_id: 1, from: { id: 5 }, chat: { id: 5 }, poll: { id: "p1" } },
    });
    expect(r?.kind === "unsupported" && r.unsupported_type).toBe("poll");
  });

  it("detects contact", () => {
    const r = parseTelegramUpdate({
      message: { message_id: 1, from: { id: 5 }, chat: { id: 5 }, contact: { phone_number: "555" } },
    });
    expect(r?.kind === "unsupported" && r.unsupported_type).toBe("contact");
  });

  it("detects animation (GIF)", () => {
    const r = parseTelegramUpdate({
      message: { message_id: 1, from: { id: 5 }, chat: { id: 5 }, animation: { file_id: "a1" } },
    });
    expect(r?.kind === "unsupported" && r.unsupported_type).toBe("animation");
  });

  it("returns null for completely empty message", () => {
    const r = parseTelegramUpdate({
      message: { message_id: 1, from: { id: 5 }, chat: { id: 5 } },
    });
    expect(r).toBeNull();
  });
});

describe("parseTelegramUpdate callback_query", () => {
  it("parses a callback_query update", () => {
    const parsed = parseTelegramUpdate({
      callback_query: {
        id: "CBQID",
        from: { id: 312, first_name: "Yossi" },
        message: { message_id: 99, chat: { id: 312 } },
        data: "use:acme-mobile",
      },
    });
    expect(parsed?.kind).toBe("callback_query");
    if (parsed?.kind === "callback_query") {
      expect(parsed.callback_query_id).toBe("CBQID");
      expect(parsed.tg_user_id).toBe(312);
      expect(parsed.chat_id).toBe(312);
      expect(parsed.message_id).toBe(99);
      expect(parsed.data).toBe("use:acme-mobile");
    }
  });

  it("returns null for callback_query missing required fields", () => {
    expect(parseTelegramUpdate({ callback_query: { id: "X" } })).toBeNull();
  });
});

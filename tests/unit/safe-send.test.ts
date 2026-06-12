import { describe, it, expect, vi } from "vitest";
import { safeSend } from "../../src/lib/telegram";

describe("safeSend", () => {
  it("returns the result of sendMessage on success", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 7 })) };
    const r = await safeSend(tg as any, 42, "hello", "test_label");
    expect(r).toEqual({ message_id: 7 });
    expect(tg.sendMessage).toHaveBeenCalledWith(42, "hello", undefined);
  });

  it("forwards options when provided", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    await safeSend(tg as any, 1, "x", "lbl", { parseMode: "Markdown" });
    expect(tg.sendMessage).toHaveBeenCalledWith(1, "x", { parseMode: "Markdown" });
  });

  it("logs to console.warn and returns null on error, without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tg = { sendMessage: vi.fn(async () => { throw new Error("Bad Request: chat not found"); }) };
    const r = await safeSend(tg as any, 99, "x", "client_apology");
    expect(r).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "send_failed",
      expect.objectContaining({ label: "client_apology", chat_id: 99, error: expect.stringContaining("chat not found") })
    );
    warnSpy.mockRestore();
  });
});

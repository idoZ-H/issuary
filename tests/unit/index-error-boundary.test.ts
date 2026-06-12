import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/handlers/telegram", async () => {
  const actual = await vi.importActual<typeof import("../../src/handlers/telegram")>(
    "../../src/handlers/telegram",
  );
  return {
    ...actual,
    handleTelegramWebhook: vi.fn(async () => { throw new Error("boom"); }),
  };
});

import worker from "../../src/index";

describe("Worker error boundary", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("returns 200 health JSON on GET / (boundary doesn't break health)", async () => {
    const req = new Request("https://w/", { method: "GET" });
    const res = await worker.fetch(req, {} as any, { waitUntil: () => {} } as any);
    expect(res.status).toBe(200);
    const j = await res.json<any>();
    expect(j.ok).toBe(true);
  });

  it("returns 200 (not 500) and logs worker_error when a handler throws", async () => {
    const body = JSON.stringify({
      update_id: 1,
      message: {
        message_id: 1, from: { id: 99, first_name: "X" }, chat: { id: 99 },
        date: Math.floor(Date.now() / 1000), text: "hi",
      },
    });
    const req = new Request("https://w/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    // No TELEGRAM_BOT_TOKEN → bestEffortClientApology early-returns and we
    // exercise just the catch + log + 200 path without needing a real bot.
    const env = {};
    const res = await worker.fetch(req, env as any, { waitUntil: () => {} } as any);
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      "worker_error",
      expect.objectContaining({
        url: "https://w/telegram/webhook",
        method: "POST",
        error_message: "boom",
      }),
    );
  });
});

import { describe, it, expect } from "vitest";
import { verifyTelegramSecret } from "../../src/lib/telegram";

describe("verifyTelegramSecret", () => {
  it("accepts a request with the matching secret header", () => {
    const req = new Request("https://example.com", {
      headers: { "X-Telegram-Bot-Api-Secret-Token": "right-secret" },
    });
    expect(verifyTelegramSecret(req, "right-secret")).toBe(true);
  });

  it("rejects a request with a wrong secret", () => {
    const req = new Request("https://example.com", {
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
    });
    expect(verifyTelegramSecret(req, "right-secret")).toBe(false);
  });

  it("rejects a request with no header", () => {
    const req = new Request("https://example.com");
    expect(verifyTelegramSecret(req, "right-secret")).toBe(false);
  });
});

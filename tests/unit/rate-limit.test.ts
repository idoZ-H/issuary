// tests/unit/rate-limit.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { checkAndIncrementMsgRate, recordSpend } from "../../src/pipeline/rate-limit";

const HOUR_KEY_FIXED = "2026-04-29T14";

describe("rate limiter", () => {
  it("allows the first 30 messages per hour", async () => {
    for (let i = 0; i < 30; i++) {
      const r = await checkAndIncrementMsgRate(env as any, 1, HOUR_KEY_FIXED);
      expect(r.allowed).toBe(true);
    }
  });

  it("rejects the 31st message in the same hour", async () => {
    for (let i = 0; i < 30; i++) {
      await checkAndIncrementMsgRate(env as any, 2, HOUR_KEY_FIXED);
    }
    const r = await checkAndIncrementMsgRate(env as any, 2, HOUR_KEY_FIXED);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("hourly_message_cap");
  });

  it("tracks spend per day in cents", async () => {
    await recordSpend(env as any, 3, 50, "2026-04-29");
    await recordSpend(env as any, 3, 70, "2026-04-29");
    const r = await checkAndIncrementMsgRate(env as any, 3, HOUR_KEY_FIXED);
    expect(r.allowed).toBe(true);          // message cap not yet hit
    expect(r.spend_cents_today).toBe(120);
  });

  it("blocks once the daily spend cap is reached", async () => {
    await recordSpend(env as any, 4, 200, "2026-04-29");
    const r = await checkAndIncrementMsgRate(env as any, 4, HOUR_KEY_FIXED);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("daily_spend_cap");
    expect(r.spend_cents_today).toBe(200);
  });
});

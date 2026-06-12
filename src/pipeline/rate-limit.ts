import type { Env } from "../types";

const MSG_CAP_PER_HOUR = 30;
const SPEND_CAP_CENTS_PER_DAY = 200;  // $2.00

export interface RateCheck {
  allowed: boolean;
  reason?: "hourly_message_cap" | "daily_spend_cap";
  msgs_this_hour: number;
  spend_cents_today: number;
}

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function thisHourKey(now = new Date()): string {
  return now.toISOString().slice(0, 13);
}

export async function checkAndIncrementMsgRate(
  env: Env,
  tgUserId: number,
  hourKey = thisHourKey(),
  dateKey = hourKey.slice(0, 10)
): Promise<RateCheck> {
  const msgKey = `${tgUserId}:msgs:${hourKey}`;
  const spendKey = `${tgUserId}:usd:${dateKey}`;

  const [currentMsgsRaw, currentSpendRaw] = await Promise.all([
    env.RATE_LIMITS.get(msgKey),
    env.RATE_LIMITS.get(spendKey),
  ]);
  const currentMsgs = Number(currentMsgsRaw ?? 0);
  const currentSpend = Number(currentSpendRaw ?? 0);

  if (currentSpend >= SPEND_CAP_CENTS_PER_DAY) {
    return { allowed: false, reason: "daily_spend_cap", msgs_this_hour: currentMsgs, spend_cents_today: currentSpend };
  }
  if (currentMsgs >= MSG_CAP_PER_HOUR) {
    return { allowed: false, reason: "hourly_message_cap", msgs_this_hour: currentMsgs, spend_cents_today: currentSpend };
  }

  await env.RATE_LIMITS.put(msgKey, String(currentMsgs + 1), { expirationTtl: 60 * 60 });
  return {
    allowed: true,
    msgs_this_hour: currentMsgs + 1,
    spend_cents_today: currentSpend,
  };
}

export async function recordSpend(env: Env, tgUserId: number, cents: number, dateKey = todayKey()): Promise<void> {
  // Best-effort spend accumulation. Workers KV has no compare-and-swap, so two
  // concurrent classifier completions for the same user can both read the same
  // current total and overwrite each other, dropping increments. Acceptable for
  // a soft daily cap — the worst case is the cap leaking by a few cents under
  // burst load. Callers (T22) should not rely on this for hard accounting.
  const key = `${tgUserId}:usd:${dateKey}`;
  const current = Number((await env.RATE_LIMITS.get(key)) ?? 0);
  await env.RATE_LIMITS.put(key, String(current + cents), { expirationTtl: 24 * 60 * 60 });
}

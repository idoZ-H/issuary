import type { Env, RecentActivity } from "../types";
import { getRecentActivity, putRecentActivity } from "../lib/kv";

// Thin wrapper so handler code reads as a domain operation rather than a KV
// access. The 60s expiry comes from RECENT_TTL_S in lib/kv.ts — a follow-up
// message arriving within that window aggregates into the same GitHub issue
// instead of opening a new one.
export async function findRecentActivity(
  env: Env,
  tgUserId: number,
  projectId: string
): Promise<RecentActivity | null> {
  return getRecentActivity(env, tgUserId, projectId);
}

export async function recordActivity(
  env: Env,
  tgUserId: number,
  projectId: string,
  ra: RecentActivity
): Promise<void> {
  await putRecentActivity(env, tgUserId, projectId, ra);
}

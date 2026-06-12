// Cloudflare GraphQL Analytics reader for the admin usage panel: Workers AI
// neurons (vs the 10k/day free tier) and KV op counts. Optional + cached +
// graceful: any failure collapses to { ok:false } so the page always renders.

import type { Env } from "../types";

export const NEURON_DAILY_FREE = 10_000;
const GQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_TTL_MS = 60_000;

export interface UsageSnapshot {
  ok: boolean;
  error?: string;
  neurons_today: number;
  neuron_daily_free: number;
  neurons_by_day: Array<{ date: string; neurons: number }>;
  kv_ops: { read: number; write: number; list: number; delete: number };
}

export interface UsageDeps {
  fetcher?: typeof fetch;
  now?: () => number;
  today?: () => string; // YYYY-MM-DD (UTC)
}

let cache: { snapshot: UsageSnapshot; expiresAt: number } | null = null;
export function __resetUsageCache(): void { cache = null; }

function emptyKv() { return { read: 0, write: 0, list: 0, delete: 0 }; }

function notOk(error: string): UsageSnapshot {
  return { ok: false, error, neurons_today: 0, neuron_daily_free: NEURON_DAILY_FREE, neurons_by_day: [], kv_ops: emptyKv() };
}

export function parseUsage(json: any, todayStr: string): UsageSnapshot {
  if (!json || json.errors?.length || !json.data?.viewer?.accounts?.[0]) {
    return notOk("graphql error");
  }
  const acct = json.data.viewer.accounts[0];
  const byDay = (acct.aiInferenceAdaptiveGroups ?? [])
    .map((g: any) => ({ date: String(g.dimensions?.date ?? ""), neurons: Number(g.sum?.totalNeurons ?? 0) }))
    .sort((a: any, b: any) => b.date.localeCompare(a.date));
  const kv = emptyKv();
  for (const g of acct.kvOperationsAdaptiveGroups ?? []) {
    const k = String(g.dimensions?.actionType ?? "");
    if (k === "read" || k === "write" || k === "list" || k === "delete") kv[k] = Number(g.sum?.requests ?? 0);
  }
  const today = byDay.find((d: { date: string }) => d.date === todayStr);
  return {
    ok: true,
    neurons_today: today?.neurons ?? 0,
    neuron_daily_free: NEURON_DAILY_FREE,
    neurons_by_day: byDay,
    kv_ops: kv,
  };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekAgoUtc(nowMs: number): string {
  return new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const QUERY = `query($a:String!,$d:String!){viewer{accounts(filter:{accountTag:$a}){aiInferenceAdaptiveGroups(limit:100,filter:{date_geq:$d},orderBy:[date_DESC]){sum{totalNeurons}dimensions{date}} kvOperationsAdaptiveGroups(limit:100,filter:{date_geq:$d}){sum{requests}dimensions{actionType}}}}}`;

export async function fetchUsage(env: Env, deps: UsageDeps = {}): Promise<UsageSnapshot> {
  const now = (deps.now ?? Date.now)();
  if (cache && now < cache.expiresAt) return cache.snapshot;

  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN;
  if (!account || !token) return notOk("not configured");

  const fetcher = deps.fetcher ?? fetch;
  const todayStr = (deps.today ?? todayUtc)();
  try {
    const res = await fetcher(GQL_URL, {
      method: "POST",
      headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { a: account, d: weekAgoUtc(now) } }),
    });
    if (!res.ok) return notOk(`http ${res.status}`);
    const snapshot = parseUsage(await res.json(), todayStr);
    if (snapshot.ok) cache = { snapshot, expiresAt: now + CACHE_TTL_MS };
    return snapshot;
  } catch (e) {
    return notOk((e as Error).message);
  }
}

import { describe, it, expect, vi } from "vitest";
import { parseUsage, fetchUsage, __resetUsageCache } from "../../src/admin/usage";

const GQL = {
  data: { viewer: { accounts: [{
    aiInferenceAdaptiveGroups: [
      { dimensions: { date: "2026-06-05" }, sum: { totalNeurons: 1200.5 } },
      { dimensions: { date: "2026-06-04" }, sum: { totalNeurons: 12371.0 } },
    ],
    kvOperationsAdaptiveGroups: [
      { dimensions: { actionType: "read" }, sum: { requests: 6120 } },
      { dimensions: { actionType: "write" }, sum: { requests: 280 } },
      { dimensions: { actionType: "list" }, sum: { requests: 2860 } },
    ],
  }] } },
  errors: null,
};

describe("parseUsage", () => {
  it("parses neurons-today and kv ops", () => {
    const u = parseUsage(GQL, "2026-06-05");
    expect(u.ok).toBe(true);
    expect(u.neurons_today).toBeCloseTo(1200.5);
    expect(u.kv_ops.read).toBe(6120);
    expect(u.kv_ops.delete).toBe(0);
    expect(u.neurons_by_day[0]!.date).toBe("2026-06-05");
  });
});

describe("fetchUsage", () => {
  it("returns not-configured when secrets missing", async () => {
    __resetUsageCache();
    const u = await fetchUsage({} as any, { now: () => 0 });
    expect(u.ok).toBe(false);
    expect(u.error).toMatch(/configured/i);
  });
  it("fetches + caches", async () => {
    __resetUsageCache();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(GQL)));
    const env = { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_ANALYTICS_TOKEN: "t" } as any;
    const u1 = await fetchUsage(env, { fetcher: fetcher as any, now: () => 1000, today: () => "2026-06-05" });
    expect(u1.ok).toBe(true);
    const u2 = await fetchUsage(env, { fetcher: fetcher as any, now: () => 2000, today: () => "2026-06-05" });
    expect(u2.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1); // cached within TTL
  });
  it("returns error on graphql errors", async () => {
    __resetUsageCache();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: null, errors: [{ message: "nope" }] })));
    const env = { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_ANALYTICS_TOKEN: "t" } as any;
    const u = await fetchUsage(env, { fetcher: fetcher as any, now: () => 0, today: () => "2026-06-05" });
    expect(u.ok).toBe(false);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runIndexMaintenance } from "../../src/pipeline/index-maintenance";
import { ensureFreshIndex } from "../../src/pipeline/code-index";
import { getIndexManifest, putIndexManifest } from "../../src/lib/kv";
import { CHUNKER_VERSION } from "../../src/lib/chunker";
import * as vecStub from "../stubs/vectorize";

// 8 days before NOW → the complete manifest is stale (> 7d TTL), so maintenance
// picks it up and runs the (now diff-based) ensureFreshIndex instead of a full
// rebuild.
const NOW_MS = Date.parse("2026-05-30T12:00:00Z");
const STALE = new Date(NOW_MS - 8 * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  vecStub.__resetVectorizeStub();
});

describe("runIndexMaintenance — diff path demotes the full rebuild", () => {
  it("a stale but UNCHANGED repo costs zero embeds and just refreshes fetched_at", async () => {
    const repo = "maint-diff/unchanged";
    await putIndexManifest(env as any, repo, {
      repo, fetched_at: STALE, chunk_count: 1, chunker_version: CHUNKER_VERSION,
      status: "complete", cursor: 1, paths: ["a.ts"],
      file_shas: { "a.ts": "s1" }, file_chunks: { "a.ts": [1] },
    });

    // Tree blob SHA unchanged → diff finds nothing to do.
    const gh = {
      getRepoTreeDetailed: async () => [{ path: "a.ts", sha: "s1" }],
      getRepoTree: async () => ["a.ts"],
      readFile: async (_r: string, p: string) => ({ path: p, content: "code", size_bytes: 4, truncated: false }),
    } as any;

    await runIndexMaintenance(env as any, {
      buildGh: async () => gh,
      now: () => NOW_MS,
      // Real ensureFreshIndex, with the in-memory vec stub injected.
      ensureFreshIndexFn: (e, r, g) => ensureFreshIndex(e, r, g, { vec: vecStub, now: () => NOW_MS }),
    });

    // The defining property of the demotion: a stale-but-unchanged repo embeds nothing.
    expect(vecStub.__getVectorizeStubState().embedCalls).toBe(0);
    // fetched_at advanced, so the cheap re-check window restarts without a rebuild.
    const m = await getIndexManifest(env as any, repo);
    expect(m!.fetched_at).toBe(new Date(NOW_MS).toISOString());
    expect(m!.status).toBe("complete");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyIncremental } from "../../src/pipeline/code-index";
import { getIndexManifest, putIndexManifest } from "../../src/lib/kv";
import { CHUNKER_VERSION, type Chunker, type CodeChunk } from "../../src/lib/chunker";
import * as vecStub from "../stubs/vectorize";

const T0 = "2026-05-01T00:00:00.000Z";
const FIXED_NOW = Date.parse("2026-05-30T12:00:00Z");

function fixedChunker(perFile: number): Chunker {
  return {
    version: CHUNKER_VERSION,
    chunk(content: string, path: string): CodeChunk[] {
      return Array.from({ length: perFile }, (_, i) => ({
        path, start_line: i + 1, end_line: i + 1, text: `${path}:${i}:${content.slice(0, 5)}`,
      }));
    },
  };
}

function ghTree(tree: Array<{ path: string; sha: string }>) {
  return {
    getRepoTreeDetailed: async () => tree,
    getRepoTree: async () => tree.map((t) => t.path),
    readFile: async (_r: string, path: string) => ({ path, content: "code", size_bytes: 4, truncated: false }),
  } as any;
}

const deps = (over: any = {}) => ({ vec: vecStub, now: () => FIXED_NOW, chunker: fixedChunker(1), ...over });

beforeEach(() => {
  vecStub.__resetVectorizeStub();
  delete (env as any).CODE_INDEX;
});

describe("applyIncremental", () => {
  it("re-embeds changed, deletes removed, merges manifest, leaves fetched_at untouched", async () => {
    await putIndexManifest(env as any, "o/r", {
      repo: "o/r", fetched_at: T0, chunk_count: 3, chunker_version: CHUNKER_VERSION,
      status: "complete", cursor: 3, paths: ["a.ts", "gone.ts", "keep.ts"],
      file_shas: { "a.ts": "old", "gone.ts": "g", "keep.ts": "k" },
      file_chunks: { "a.ts": [1], "gone.ts": [1], "keep.ts": [1] },
    });
    const deleted: string[] = [];
    (env as any).CODE_INDEX = { deleteByIds: async (ids: string[]) => { deleted.push(...ids); } };
    const gh = ghTree([{ path: "a.ts", sha: "new" }, { path: "keep.ts", sha: "k" }]); // gone.ts removed

    await applyIncremental(env as any, "o/r", gh, ["a.ts"], ["gone.ts"], deps({ headSha: "deadbeef" }));

    // a.ts re-embedded.
    expect(vecStub.__getVectorizeStubState().stored.map((s) => s.path)).toEqual(["a.ts"]);
    // gone.ts vectors deleted.
    expect(deleted).toEqual(["o/r:gone.ts:1"]);

    const m = await getIndexManifest(env as any, "o/r");
    expect(m!.file_shas).toEqual({ "a.ts": "new", "keep.ts": "k" }); // a updated, gone removed, keep untouched
    expect(m!.file_chunks!["gone.ts"]).toBeUndefined();
    expect(m!.file_chunks!["keep.ts"]).toEqual([1]); // untouched
    expect(m!.fetched_at).toBe(T0); // UNCHANGED — TTL safety net stays armed
    expect(m!.head_sha).toBe("deadbeef");
  });

  it("does not touch file_shas for files not in the changed/removed sets", async () => {
    await putIndexManifest(env as any, "o/r2", {
      repo: "o/r2", fetched_at: T0, chunk_count: 2, chunker_version: CHUNKER_VERSION,
      status: "complete", cursor: 2, paths: ["a.ts", "stale.ts"],
      file_shas: { "a.ts": "1", "stale.ts": "2" }, file_chunks: { "a.ts": [1], "stale.ts": [1] },
    });
    // The tree reports stale.ts with a DIFFERENT sha, but the push didn't list it.
    // applyIncremental must NOT silently bless that sha (the cron diff catches it later).
    const gh = ghTree([{ path: "a.ts", sha: "1b" }, { path: "stale.ts", sha: "2-CHANGED" }]);
    await applyIncremental(env as any, "o/r2", gh, ["a.ts"], [], deps());
    const m = await getIndexManifest(env as any, "o/r2");
    expect(m!.file_shas!["stale.ts"]).toBe("2"); // unchanged baseline → diff will re-embed it next cron
    expect(m!.file_shas!["a.ts"]).toBe("1b");
  });

  it("deletes orphaned chunks when a pushed file shrinks", async () => {
    await putIndexManifest(env as any, "o/shrink", {
      repo: "o/shrink", fetched_at: T0, chunk_count: 3, chunker_version: CHUNKER_VERSION,
      status: "complete", cursor: 1, paths: ["big.ts"],
      file_shas: { "big.ts": "1" }, file_chunks: { "big.ts": [1, 46, 91] },
    });
    const deleted: string[] = [];
    (env as any).CODE_INDEX = { deleteByIds: async (ids: string[]) => { deleted.push(...ids); } };
    const gh = ghTree([{ path: "big.ts", sha: "2" }]); // fixedChunker(1) → 1 new chunk
    await applyIncremental(env as any, "o/shrink", gh, ["big.ts"], [], deps());

    expect(deleted.sort()).toEqual(["o/shrink:big.ts:46", "o/shrink:big.ts:91"]);
    const m = await getIndexManifest(env as any, "o/shrink");
    expect(m!.file_chunks!["big.ts"]).toEqual([1]);
  });

  it("bails to a fresh build kickoff when no usable manifest exists", async () => {
    const gh = ghTree([{ path: "a.ts", sha: "1" }]);
    await applyIncremental(env as any, "o/fresh", gh, ["a.ts"], [], deps());
    const m = await getIndexManifest(env as any, "o/fresh");
    expect(m).not.toBeNull();
    expect(m!.file_shas).toEqual({ "a.ts": "1" });
  });
});

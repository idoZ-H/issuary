import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { diffTree, ensureFreshIndex } from "../../src/pipeline/code-index";
import { getIndexManifest, putIndexManifest } from "../../src/lib/kv";
import { CHUNKER_VERSION, type Chunker, type CodeChunk } from "../../src/lib/chunker";
import * as vecStub from "../stubs/vectorize";

const FIXED_NOW = Date.parse("2026-05-30T12:00:00Z");
const STALE = new Date(FIXED_NOW - 8 * 24 * 60 * 60 * 1000).toISOString(); // > 7d TTL
const FRESH = new Date(FIXED_NOW - 60_000).toISOString();

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

// gh exposing a tree-with-shas + readFile, for diff-path assertions.
function ghTree(tree: Array<{ path: string; sha: string }>, contents: Record<string, string> = {}) {
  const counters = { trees: 0 };
  return {
    counters,
    gh: {
      getRepoTreeDetailed: async () => { counters.trees++; return tree; },
      getRepoTree: async () => tree.map((t) => t.path),
      readFile: async (_r: string, path: string) => ({
        path, content: contents[path] ?? "code here", size_bytes: 9, truncated: false,
      }),
    } as any,
  };
}

const deps = (over: any = {}) => ({ vec: vecStub, now: () => FIXED_NOW, chunker: fixedChunker(1), ...over });

beforeEach(() => {
  vecStub.__resetVectorizeStub();
  delete (env as any).CODE_INDEX;
});

describe("diffTree", () => {
  it("classifies changed, new, removed", () => {
    const prev = { "a.ts": "1", "b.ts": "2", "gone.ts": "3" };
    const tree = [{ path: "a.ts", sha: "1" }, { path: "b.ts", sha: "X" }, { path: "new.ts", sha: "9" }];
    expect(diffTree(prev, tree)).toEqual({ changed: ["b.ts", "new.ts"], removed: ["gone.ts"] });
  });

  it("treats empty/absent sha as changed", () => {
    const prev = { "a.ts": "1" };
    const tree = [{ path: "a.ts", sha: "" }, { path: "b.ts", sha: "" }];
    expect(diffTree(prev, tree)).toEqual({ changed: ["a.ts", "b.ts"], removed: [] });
  });
});

describe("ensureFreshIndex — blob-SHA diff path", () => {
  it("re-embeds only changed files and deletes removed ones", async () => {
    await putIndexManifest(env as any, "acme/diff", {
      repo: "acme/diff", fetched_at: STALE, chunk_count: 3, chunker_version: CHUNKER_VERSION,
      status: "complete", cursor: 3, paths: ["a.ts", "b.ts", "gone.ts"],
      file_shas: { "a.ts": "1", "b.ts": "2", "gone.ts": "3" },
      file_chunks: { "a.ts": [1], "b.ts": [1], "gone.ts": [1] },
    });
    const deleted: string[] = [];
    (env as any).CODE_INDEX = { deleteByIds: async (ids: string[]) => { deleted.push(...ids); } };
    const { gh } = ghTree([
      { path: "a.ts", sha: "1" }, // unchanged
      { path: "b.ts", sha: "X" }, // changed
      { path: "new.ts", sha: "9" }, // new
    ]);
    const res = await ensureFreshIndex(env as any, "acme/diff", gh, deps());

    expect(res.built).toBe(true);
    expect(res.complete).toBe(true);
    // Only b.ts and new.ts embedded — a.ts unchanged, gone.ts removed.
    const stored = vecStub.__getVectorizeStubState().stored.map((s) => s.path).sort();
    expect(stored).toEqual(["b.ts", "new.ts"]);
    // gone.ts vectors deleted via its stored chunk start lines.
    expect(deleted).toEqual(["acme/diff:gone.ts:1"]);

    const m = await getIndexManifest(env as any, "acme/diff");
    expect(m!.file_shas).toEqual({ "a.ts": "1", "b.ts": "X", "new.ts": "9" });
    expect(m!.file_chunks!["gone.ts"]).toBeUndefined();
    expect(m!.fetched_at).toBe(new Date(FIXED_NOW).toISOString());
    expect(m!.status).toBe("complete");
  });

  it("does no work when an unchanged stale repo is diffed", async () => {
    await putIndexManifest(env as any, "acme/nochange", {
      repo: "acme/nochange", fetched_at: STALE, chunk_count: 1, chunker_version: CHUNKER_VERSION,
      status: "complete", cursor: 1, paths: ["a.ts"],
      file_shas: { "a.ts": "1" }, file_chunks: { "a.ts": [1] },
    });
    const { gh } = ghTree([{ path: "a.ts", sha: "1" }]);
    const res = await ensureFreshIndex(env as any, "acme/nochange", gh, deps());
    expect(res.built).toBe(false);
    expect(vecStub.__getVectorizeStubState().embedCalls).toBe(0);
    // fetched_at advances so the next TTL window restarts (cheap re-check, no embeds).
    const m = await getIndexManifest(env as any, "acme/nochange");
    expect(m!.fetched_at).toBe(new Date(FIXED_NOW).toISOString());
  });

  it("skips the diff and stays fresh within TTL (no tree call)", async () => {
    await putIndexManifest(env as any, "acme/fresh", {
      repo: "acme/fresh", fetched_at: FRESH, chunk_count: 1, chunker_version: CHUNKER_VERSION,
      status: "complete", cursor: 1, paths: ["a.ts"], file_shas: { "a.ts": "1" }, file_chunks: { "a.ts": [1] },
    });
    const { gh, counters } = ghTree([{ path: "a.ts", sha: "1" }]);
    const res = await ensureFreshIndex(env as any, "acme/fresh", gh, deps());
    expect(res.built).toBe(false);
    expect(counters.trees).toBe(0);
  });

  it("falls back to a full rebuild for a legacy manifest without file_shas (migration)", async () => {
    await putIndexManifest(env as any, "acme/legacy", {
      repo: "acme/legacy", fetched_at: STALE, chunk_count: 2, chunker_version: CHUNKER_VERSION,
      status: "complete", cursor: 2, paths: ["a.ts", "b.ts"], // no file_shas
    });
    const { gh } = ghTree([{ path: "a.ts", sha: "1" }, { path: "b.ts", sha: "2" }]);
    const res = await ensureFreshIndex(env as any, "acme/legacy", gh, deps());
    expect(res.built).toBe(true);
    // Full rebuild re-embeds everything AND populates the new fields.
    expect(vecStub.__getVectorizeStubState().stored.length).toBe(2);
    const m = await getIndexManifest(env as any, "acme/legacy");
    expect(m!.file_shas).toEqual({ "a.ts": "1", "b.ts": "2" });
  });

  it("deletes orphaned chunks when a changed file shrinks", async () => {
    // a.ts previously had 3 chunks (start_lines 1,46,91); the new version chunks
    // to just start_line 1. The 46/91 vectors must be deleted, not orphaned.
    await putIndexManifest(env as any, "acme/shrink", {
      repo: "acme/shrink", fetched_at: STALE, chunk_count: 3, chunker_version: CHUNKER_VERSION,
      status: "complete", cursor: 1, paths: ["a.ts"],
      file_shas: { "a.ts": "1" }, file_chunks: { "a.ts": [1, 46, 91] },
    });
    const deleted: string[] = [];
    (env as any).CODE_INDEX = { deleteByIds: async (ids: string[]) => { deleted.push(...ids); } };
    const { gh } = ghTree([{ path: "a.ts", sha: "2" }]); // changed
    await ensureFreshIndex(env as any, "acme/shrink", gh, deps()); // fixedChunker(1) → 1 new chunk

    expect(deleted.sort()).toEqual(["acme/shrink:a.ts:46", "acme/shrink:a.ts:91"]);
    const m = await getIndexManifest(env as any, "acme/shrink");
    expect(m!.file_chunks!["a.ts"]).toEqual([1]); // only the surviving chunk remains
  });

  it("slices a large change set across invocations and advances fetched_at only when drained", async () => {
    const paths = ["f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts"];
    await putIndexManifest(env as any, "acme/slice", {
      repo: "acme/slice", fetched_at: STALE, chunk_count: 5, chunker_version: CHUNKER_VERSION,
      status: "complete", cursor: 5, paths,
      file_shas: Object.fromEntries(paths.map((p) => [p, "old"])),
      file_chunks: Object.fromEntries(paths.map((p) => [p, [1]])),
    });
    const tree = paths.map((p) => ({ path: p, sha: "new" })); // all 5 changed

    // First invocation: only 2 of 5 processed → not drained, fetched_at stays stale.
    const r1 = await ensureFreshIndex(env as any, "acme/slice", ghTree(tree).gh, deps({ filesPerSlice: 2 }));
    expect(r1.complete).toBe(false);
    expect((await getIndexManifest(env as any, "acme/slice"))!.fetched_at).toBe(STALE);

    // Drive to completion; fetched_at advances only on the final, draining slice.
    let r = r1;
    for (let i = 0; i < 5 && !r.complete; i++) {
      r = await ensureFreshIndex(env as any, "acme/slice", ghTree(tree).gh, deps({ filesPerSlice: 2 }));
    }
    expect(r.complete).toBe(true);
    expect((await getIndexManifest(env as any, "acme/slice"))!.fetched_at).toBe(new Date(FIXED_NOW).toISOString());
  });

  it("falls back to a full rebuild on a chunker-version bump", async () => {
    await putIndexManifest(env as any, "acme/bump", {
      repo: "acme/bump", fetched_at: FRESH, chunk_count: 1, chunker_version: "OLD",
      status: "complete", cursor: 1, paths: ["a.ts"], file_shas: { "a.ts": "1" }, file_chunks: { "a.ts": [1] },
    });
    const { gh } = ghTree([{ path: "a.ts", sha: "1" }, { path: "b.ts", sha: "2" }]);
    const res = await ensureFreshIndex(env as any, "acme/bump", gh, deps());
    expect(res.built).toBe(true);
    expect(vecStub.__getVectorizeStubState().stored.length).toBe(2); // full re-embed under the new chunker
  });
});

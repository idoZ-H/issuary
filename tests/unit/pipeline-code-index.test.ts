import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  ensureFreshIndex,
  retrieveCode,
  isExcludedFromCodeIndex,
  formatQueryForEmbedding,
  BGE_QUERY_PREFIX,
  RETRIEVAL_CANDIDATE_K,
} from "../../src/pipeline/code-index";
import { putIndexManifest } from "../../src/lib/kv";
import { CHUNKER_VERSION, type Chunker, type CodeChunk } from "../../src/lib/chunker";
import * as vecStub from "../stubs/vectorize";

const FIXED_NOW = Date.parse("2026-05-30T12:00:00Z");
const REPO = "acme/widget";

// A fake GitHubClient exposing only what the pipeline uses.
function fakeGh(files: Record<string, string>) {
  return {
    getRepoTree: async (_repo: string) => Object.keys(files),
    getRepoTreeDetailed: async (_repo: string) =>
      Object.keys(files).map((p) => ({ path: p, sha: `sha-${p}` })),
    readFile: async (_repo: string, path: string) => ({
      path,
      content: files[path] ?? "",
      size_bytes: (files[path] ?? "").length,
      truncated: false,
    }),
  } as any;
}

// A chunker that emits a fixed number of trivial chunks per file, for
// deterministic cap testing.
function fixedChunker(perFile: number): Chunker {
  return {
    version: CHUNKER_VERSION,
    chunk(content: string, path: string): CodeChunk[] {
      return Array.from({ length: perFile }, (_, i) => ({
        path,
        start_line: i + 1,
        end_line: i + 1,
        text: `${path}:${i}:${content.slice(0, 5)}`,
      }));
    },
  };
}

const deps = (over: Partial<Parameters<typeof ensureFreshIndex>[3]> = {}) => ({
  vec: vecStub,
  now: () => FIXED_NOW,
  ...over,
});

beforeEach(() => {
  vecStub.__resetVectorizeStub();
});

describe("ensureFreshIndex", () => {
  it("skips the build when the manifest is fresh and same chunker version", async () => {
    await putIndexManifest(env as any, REPO, {
      repo: REPO,
      fetched_at: new Date(FIXED_NOW - 60_000).toISOString(), // 1 min old
      chunk_count: 3,
      chunker_version: CHUNKER_VERSION,
      status: "complete",
      cursor: 1,
      paths: ["a.ts"],
    });
    const gh = fakeGh({ "a.ts": "x".repeat(100) });
    const res = await ensureFreshIndex(env as any, REPO, gh, deps());
    expect(res.built).toBe(false);
    expect(vecStub.__getVectorizeStubState().embedCalls).toBe(0);
  });

  it("rebuilds when the manifest is stale (older than TTL)", async () => {
    await putIndexManifest(env as any, REPO, {
      repo: REPO,
      fetched_at: new Date(FIXED_NOW - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8d old > 7d TTL
      chunk_count: 3,
      chunker_version: CHUNKER_VERSION,
      status: "complete",
      cursor: 1,
      paths: ["a.ts"],
    });
    const gh = fakeGh({ "a.ts": "hello world" });
    const res = await ensureFreshIndex(env as any, REPO, gh, deps({ chunker: fixedChunker(2) }));
    expect(res.built).toBe(true);
    expect(res.chunk_count).toBe(2);
    expect(vecStub.__getVectorizeStubState().stored.length).toBe(2);
  });

  it("rebuilds when the chunker version differs", async () => {
    await putIndexManifest(env as any, REPO, {
      repo: REPO,
      fetched_at: new Date(FIXED_NOW - 60_000).toISOString(),
      chunk_count: 3,
      chunker_version: "OLD-VERSION",
      status: "complete",
      cursor: 1,
      paths: ["a.ts"],
    });
    const gh = fakeGh({ "a.ts": "hi" });
    const res = await ensureFreshIndex(env as any, REPO, gh, deps({ chunker: fixedChunker(1) }));
    expect(res.built).toBe(true);
  });

  it("builds from scratch when no manifest exists", async () => {
    const gh = fakeGh({ "a.ts": "alpha", "b.ts": "beta" });
    const res = await ensureFreshIndex(env as any, "acme/fresh", gh, deps({ chunker: fixedChunker(1) }));
    expect(res.built).toBe(true);
    expect(res.chunk_count).toBe(2);
  });

  it("respects the maxChunks cap", async () => {
    const gh = fakeGh({ "a.ts": "x", "b.ts": "y", "c.ts": "z" });
    const res = await ensureFreshIndex(env as any, "acme/capped", gh, deps({ chunker: fixedChunker(10), maxChunks: 5 }));
    expect(res.built).toBe(true);
    expect(res.chunk_count).toBe(5);
    expect(vecStub.__getVectorizeStubState().stored.length).toBe(5);
  });

  it("skips files larger than maxFileBytes", async () => {
    const gh = fakeGh({ "big.ts": "x".repeat(500), "small.ts": "ok" });
    const res = await ensureFreshIndex(env as any, "acme/bigfile", gh, deps({ chunker: fixedChunker(1), maxFileBytes: 100 }));
    expect(res.chunk_count).toBe(1); // only small.ts indexed
  });

  it("excludes docs/ and markdown from the code index", async () => {
    const gh = fakeGh({
      "docs/superpowers/specs/design.md": "spec prose",
      "README.md": "readme prose",
      "guide.markdown": "guide prose",
      "src/app.js": "code",
    });
    const res = await ensureFreshIndex(env as any, "acme/docs", gh, deps({ chunker: fixedChunker(1) }));
    // Only src/app.js is indexed; the three doc/markdown files are filtered out.
    expect(res.total_files).toBe(1);
    expect(res.chunk_count).toBe(1);
  });
});

describe("isExcludedFromCodeIndex", () => {
  it("excludes docs/ paths and markdown, keeps code", () => {
    expect(isExcludedFromCodeIndex("docs/x.md")).toBe(true);
    expect(isExcludedFromCodeIndex("a/docs/x.txt")).toBe(true);
    expect(isExcludedFromCodeIndex("README.md")).toBe(true);
    expect(isExcludedFromCodeIndex("notes.mdx")).toBe(true);
    expect(isExcludedFromCodeIndex("public/admin.html")).toBe(false);
    expect(isExcludedFromCodeIndex("src/services/foo.js")).toBe(false);
  });

  it("excludes binary assets (images, fonts, office docs, archives, media)", () => {
    for (const p of [
      // images (incl. case-insensitive + nested)
      "public/logo.png", "src/a.JPG", "assets/photo.jpeg", "x.gif",
      "icons/star.svg", "img/hero.webp", "favicon.ico", "x.bmp", "scan.tiff", "scan.tif",
      // fonts
      "fonts/Inter.woff", "fonts/Inter.woff2", "fonts/x.ttf", "fonts/x.otf", "fonts/x.eot",
      // office / documents
      "migration/data.xlsx", "old.xls", "spec.docx", "report.doc", "deck.pptx",
      "declaration-template.pdf",
      // archives
      "bundle.zip", "backup.tar", "backup.tar.gz", "logs.tgz", "x.rar", "x.7z", "x.bz2",
      // media
      "demo.mp4", "voice.mp3", "clip.wav", "screen.mov", "rec.webm", "note.m4a", "sound.ogg",
    ]) {
      expect(isExcludedFromCodeIndex(p)).toBe(true);
    }
  });

  it("excludes lockfiles but keeps ordinary json/yaml config", () => {
    expect(isExcludedFromCodeIndex("package-lock.json")).toBe(true);
    expect(isExcludedFromCodeIndex("frontend/package-lock.json")).toBe(true);
    expect(isExcludedFromCodeIndex("yarn.lock")).toBe(true);
    expect(isExcludedFromCodeIndex("pnpm-lock.yaml")).toBe(true);
    expect(isExcludedFromCodeIndex("npm-shrinkwrap.json")).toBe(true);
    expect(isExcludedFromCodeIndex("src/config.json")).toBe(false);
    expect(isExcludedFromCodeIndex("app/settings.yaml")).toBe(false);
  });

  it("excludes logs and dump files", () => {
    expect(isExcludedFromCodeIndex("server.log")).toBe(true);
    expect(isExcludedFromCodeIndex("logs/firebase-debug.log")).toBe(true);
    expect(isExcludedFromCodeIndex("diff.txt")).toBe(true);
    expect(isExcludedFromCodeIndex("changes.diff")).toBe(true);
    expect(isExcludedFromCodeIndex("crash.dump")).toBe(true);
    // not every .txt is a dump, and code that merely contains "log" in the name stays
    expect(isExcludedFromCodeIndex("src/dialog.js")).toBe(false);
    expect(isExcludedFromCodeIndex("LICENSE.txt")).toBe(false);
  });

  it("excludes minified bundles and bulk data files, keeps ordinary js/css", () => {
    expect(isExcludedFromCodeIndex("vendor.min.js")).toBe(true);
    expect(isExcludedFromCodeIndex("styles.min.css")).toBe(true);
    expect(isExcludedFromCodeIndex("dist/app.bundle.js")).toBe(true);
    expect(isExcludedFromCodeIndex("data/users.csv")).toBe(true);
    expect(isExcludedFromCodeIndex("data/metrics.tsv")).toBe(true);
    expect(isExcludedFromCodeIndex("src/app.js")).toBe(false);
    expect(isExcludedFromCodeIndex("src/styles.css")).toBe(false);
  });
});

// fakeGh variant that counts reads and tree walks, for slice/resume assertions.
function countingGh(files: Record<string, string>) {
  const counters = { reads: 0, trees: 0 };
  const gh = {
    getRepoTree: async (_repo: string) => {
      counters.trees++;
      return Object.keys(files);
    },
    getRepoTreeDetailed: async (_repo: string) => {
      counters.trees++;
      return Object.keys(files).map((p) => ({ path: p, sha: `sha-${p}` }));
    },
    readFile: async (_repo: string, path: string) => {
      counters.reads++;
      return { path, content: files[path] ?? "", size_bytes: (files[path] ?? "").length, truncated: false };
    },
  } as any;
  return { gh, counters };
}

function manyFiles(n: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.ts`, `content ${i}`]));
}

describe("ensureFreshIndex — incremental build", () => {
  it("indexes only the first slice when the repo exceeds FILES_PER_SLICE", async () => {
    const { gh, counters } = countingGh(manyFiles(40));
    const res = await ensureFreshIndex(env as any, "acme/big", gh, deps({ chunker: fixedChunker(1), filesPerSlice: 15 }));
    expect(res.built).toBe(true);
    expect(res.complete).toBe(false);
    expect(res.indexed_files).toBe(15);
    expect(res.total_files).toBe(40);
    expect(counters.reads).toBeLessThanOrEqual(15);
    expect(counters.trees).toBe(1);
  });

  it("resumes from the cursor without re-walking the tree", async () => {
    const { gh, counters } = countingGh(manyFiles(40));
    await ensureFreshIndex(env as any, "acme/resume", gh, deps({ chunker: fixedChunker(1), filesPerSlice: 15 }));
    const res2 = await ensureFreshIndex(env as any, "acme/resume", gh, deps({ chunker: fixedChunker(1), filesPerSlice: 15 }));
    expect(res2.indexed_files).toBe(30);
    expect(res2.complete).toBe(false);
    expect(counters.reads).toBe(30); // exactly 15 + 15 — slice 1 is never re-read
    expect(counters.trees).toBe(1);                 // tree walked once, on the first call
  });

  it("completes on the final slice and stamps the manifest complete", async () => {
    const { gh } = countingGh(manyFiles(20));
    await ensureFreshIndex(env as any, "acme/finish", gh, deps({ chunker: fixedChunker(1), filesPerSlice: 15 }));
    const res2 = await ensureFreshIndex(env as any, "acme/finish", gh, deps({ chunker: fixedChunker(1), filesPerSlice: 15 }));
    expect(res2.complete).toBe(true);
    expect(res2.indexed_files).toBe(20);
    expect(res2.chunk_count).toBe(20);
  });

  it("completes immediately for an empty repo (no files)", async () => {
    const { gh, counters } = countingGh({});
    const res = await ensureFreshIndex(env as any, "acme/empty", gh, deps({ chunker: fixedChunker(1), filesPerSlice: 15 }));
    expect(res.complete).toBe(true);
    expect(res.indexed_files).toBe(0);
    expect(res.total_files).toBe(0);
    expect(res.chunk_count).toBe(0);
    expect(counters.reads).toBe(0);
    expect(counters.trees).toBe(1);
  });

  it("restarts from scratch when a building manifest has a stale chunker version", async () => {
    await putIndexManifest(env as any, "acme/ver", {
      repo: "acme/ver",
      fetched_at: new Date(FIXED_NOW).toISOString(),
      chunk_count: 5,
      chunker_version: "OLD-VERSION",
      status: "building",
      cursor: 5,
      paths: ["stale1.ts", "stale2.ts"],
    });
    const { gh, counters } = countingGh(manyFiles(3));
    const res = await ensureFreshIndex(env as any, "acme/ver", gh, deps({ chunker: fixedChunker(1), filesPerSlice: 15 }));
    expect(counters.trees).toBe(1);     // re-walked the tree (did not resume the stale build)
    expect(res.indexed_files).toBe(3);  // indexed the NEW 3-file tree, not the stale paths
    expect(res.complete).toBe(true);
  });
});

describe("retrieveCode", () => {
  it("returns index_warming when no manifest exists yet", async () => {
    const res = await retrieveCode(env as any, "acme/never-indexed", "export button", deps());
    expect(res.status).toBe("index_warming");
  });

  it("returns index_warming while the index is still building", async () => {
    await putIndexManifest(env as any, "acme/building", {
      repo: "acme/building",
      fetched_at: new Date(FIXED_NOW).toISOString(),
      chunk_count: 15,
      chunker_version: CHUNKER_VERSION,
      status: "building",
      cursor: 15,
      paths: Array.from({ length: 40 }, (_, i) => `f${i}.ts`),
    });
    const res = await retrieveCode(env as any, "acme/building", "anything", deps());
    expect(res.status).toBe("index_warming");
  });

  it("returns chunks when the index is present", async () => {
    const gh = fakeGh({ "Dashboard.tsx": "export button code" });
    await ensureFreshIndex(env as any, "acme/has-index", gh, deps({ chunker: fixedChunker(2) }));
    await putIndexManifest(env as any, "acme/has-index", {
      repo: "acme/has-index",
      fetched_at: new Date(FIXED_NOW).toISOString(),
      chunk_count: 2,
      chunker_version: CHUNKER_VERSION,
      status: "complete",
      cursor: 1,
      paths: ["Dashboard.tsx"],
    });
    const res = await retrieveCode(env as any, "acme/has-index", "export button", deps());
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.chunks.length).toBeGreaterThan(0);
      expect(res.chunks[0]!.path).toBe("Dashboard.tsx");
    }
  });

  it("embeds the query with the bge asymmetric-retrieval instruction prefix", async () => {
    await putIndexManifest(env as any, "acme/prefix", {
      repo: "acme/prefix",
      fetched_at: new Date(FIXED_NOW).toISOString(),
      chunk_count: 1,
      chunker_version: CHUNKER_VERSION,
      status: "complete",
      cursor: 0,
      paths: ["A.ts"],
    });
    const captured: string[] = [];
    const captureVec = {
      embedTexts: async (_e: any, texts: string[]) => {
        captured.push(...texts);
        return texts.map(() => new Array(768).fill(0));
      },
      upsertChunks: vecStub.upsertChunks,
      queryChunks: vecStub.queryChunks,
    };
    await retrieveCode(env as any, "acme/prefix", "login button broken", { vec: captureVec as any });
    expect(captured).toEqual([
      "Represent this sentence for searching relevant passages: login button broken",
    ]);
  });

  it("over-fetches a wider candidate set and reranks it down to the top-K", async () => {
    await putIndexManifest(env as any, "acme/rerank", {
      repo: "acme/rerank",
      fetched_at: new Date(FIXED_NOW).toISOString(),
      chunk_count: 8,
      chunker_version: CHUNKER_VERSION,
      status: "complete",
      cursor: 0,
      paths: ["a.ts"],
    });
    // bge cosine returns these 8 candidates in a compressed band; the reranker
    // reverses the order (h best), proving the final result reflects the rerank.
    const candidates = ["a", "b", "c", "d", "e", "f", "g", "h"].map((p, i) => ({
      path: `${p}.ts`,
      start_line: 1,
      end_line: 10,
      snippet: `chunk ${p}`,
      score: 0.7 + i * 0.001,
    }));
    let requestedTopK = -1;
    let rerankSawCandidates = 0;
    const rerankVec = {
      embedTexts: async () => [new Array(768).fill(0)],
      upsertChunks: vecStub.upsertChunks,
      queryChunks: async (_e: any, _r: string, _v: number[], topK: number) => {
        requestedTopK = topK;
        return candidates;
      },
      rerankChunks: async (_e: any, _q: string, chunks: any[], topK: number) => {
        rerankSawCandidates = chunks.length;
        return [...chunks].reverse().slice(0, topK);
      },
    };
    const res = await retrieveCode(env as any, "acme/rerank", "duplicate whatsapp message", { vec: rerankVec as any });
    expect(requestedTopK).toBe(RETRIEVAL_CANDIDATE_K); // over-fetched, not just 6
    expect(rerankSawCandidates).toBe(8);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.chunks).toHaveLength(6); // narrowed to RETRIEVAL_TOP_K
      expect(res.chunks[0]!.path).toBe("h.ts"); // reranked winner, not the cosine top
    }
  });
});

describe("formatQueryForEmbedding", () => {
  it("prefixes the query with the bge retrieval instruction", () => {
    expect(formatQueryForEmbedding("login button broken")).toBe(
      `${BGE_QUERY_PREFIX}login button broken`
    );
    expect(BGE_QUERY_PREFIX).toBe("Represent this sentence for searching relevant passages: ");
  });
});

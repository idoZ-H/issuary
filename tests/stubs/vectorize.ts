// Test stub for src/lib/vectorize.ts (aliased in vitest.config.ts). Miniflare
// has no native Workers AI / Vectorize emulation, so this provides an in-memory
// stand-in with a deterministic, keyword-overlap "retrieval" so pipeline logic
// can be exercised without real embeddings.

import type { Env, RetrievedChunk } from "../../src/types";
import type { CodeChunk } from "../../src/lib/chunker";

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBED_DIM = 768;
export const RETRIEVAL_TOP_K = 6;
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";
export const RETRIEVAL_CANDIDATE_K = 24;

interface StoredChunk {
  repo: string;
  path: string;
  start_line: number;
  end_line: number;
  snippet: string;
}

// Module-level in-memory store, shared across a test's calls. Reset between
// tests via __resetVectorizeStub().
const STORE: StoredChunk[] = [];
let EMBED_CALLS = 0;

export function __resetVectorizeStub(): void {
  STORE.length = 0;
  EMBED_CALLS = 0;
}

export function __getVectorizeStubState() {
  return { stored: [...STORE], embedCalls: EMBED_CALLS };
}

export async function chunkId(repo: string, path: string, startLine: number): Promise<string> {
  return `${repo}:${path}:${startLine}`;
}

// Returns one deterministic vector per text (content not used by the stub's
// retrieval, which keys off stored snippets instead). Tracks call count so
// tests can assert batching/bounding.
export async function embedTexts(_env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  EMBED_CALLS++;
  return texts.map(() => new Array(EMBED_DIM).fill(0));
}

export async function upsertChunks(
  _env: Env,
  repo: string,
  chunks: CodeChunk[],
  _vectors: number[][]
): Promise<void> {
  for (const c of chunks) {
    STORE.push({
      repo,
      path: c.path,
      start_line: c.start_line,
      end_line: c.end_line,
      snippet: c.text.slice(0, 1000),
    });
  }
}

// Mirrors src/lib/vectorize.ts::deleteFileVectors. Derives the same ids, calls
// env.CODE_INDEX.deleteByIds when a binding is present (so unit tests can assert
// the call), and prunes the in-memory STORE so retrieval tests stop returning a
// removed file's chunks.
export async function deleteFileVectors(env: Env, repo: string, path: string, startLines: number[]): Promise<void> {
  if (startLines.length === 0) return;
  const ids = await Promise.all(startLines.map((sl) => chunkId(repo, path, sl)));
  const idx = (env as any).CODE_INDEX;
  if (idx && typeof idx.deleteByIds === "function") await idx.deleteByIds(ids);
  const lines = new Set(startLines);
  for (let i = STORE.length - 1; i >= 0; i--) {
    const s = STORE[i]!;
    if (s.repo === repo && s.path === path && lines.has(s.start_line)) STORE.splice(i, 1);
  }
}

// "Query" by embedding is not possible in the stub, so callers use
// queryChunksByText below. queryChunks ignores the vector and returns the most
// recently stored chunks for the repo (deterministic order).
export async function queryChunks(
  _env: Env,
  repo: string,
  _queryVector: number[],
  topK: number = RETRIEVAL_TOP_K
): Promise<RetrievedChunk[]> {
  return STORE.filter((s) => s.repo === repo)
    .slice(0, topK)
    .map((s) => ({
      path: s.path,
      start_line: s.start_line,
      end_line: s.end_line,
      snippet: s.snippet,
      score: 0.9,
    }));
}

// Order-preserving stub rerank (Miniflare has no Workers AI). Mirrors the real
// rerankChunks signature; keeps cosine order so retrieval tests that inject the
// stub stay deterministic. Tests exercising rerank reordering inject their own.
export async function rerankChunks(
  _env: Env,
  _query: string,
  chunks: RetrievedChunk[],
  topK: number = RETRIEVAL_TOP_K
): Promise<RetrievedChunk[]> {
  return chunks.slice(0, topK);
}

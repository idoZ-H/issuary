// Thin wrapper over Workers AI (embeddings) and Vectorize (vector store) for
// semantic code retrieval. These are native Worker bindings, so no detached-
// `fetch` workaround is needed here.
//
// In tests this module is aliased to tests/stubs/vectorize.ts (Miniflare has no
// native AI/Vectorize emulation) — same pattern as the langsmith stubs. Keep the
// exported surface (names + signatures) in lockstep with the stub.

import type { Env, RetrievedChunk } from "../types";
import type { CodeChunk } from "./chunker";

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBED_DIM = 768;
export const RETRIEVAL_TOP_K = 6;

const SNIPPET_MAX_CHARS = 1000;

// Vectorize vector ids are capped (64 bytes), and repo+path+line easily exceeds
// that — hash to a fixed-length hex id instead.
export async function chunkId(repo: string, path: string, startLine: number): Promise<string> {
  const data = new TextEncoder().encode(`${repo}:${path}:${startLine}`);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Embed a batch of texts. bge returns { shape, data: number[][] }.
export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = (await env.AI.run(EMBED_MODEL as any, { text: texts } as any)) as unknown as { data: number[][] };
  return res.data;
}

export async function upsertChunks(
  env: Env,
  repo: string,
  chunks: CodeChunk[],
  vectors: number[][]
): Promise<void> {
  if (chunks.length === 0) return;
  const items = await Promise.all(
    chunks.map(async (c, i) => ({
      id: await chunkId(repo, c.path, c.start_line),
      values: vectors[i]!,
      metadata: {
        repo,
        path: c.path,
        start_line: c.start_line,
        end_line: c.end_line,
        snippet: c.text.slice(0, SNIPPET_MAX_CHARS),
      },
    }))
  );
  await env.CODE_INDEX.upsert(items);
}

// Delete all vectors belonging to a single file, given its chunk start_lines
// (stored in the manifest's file_chunks). Vector ids are deterministic
// (SHA1(repo:path:start_line)), so the ids are re-derivable without a query.
// Used when a push/diff reports a file removed.
export async function deleteFileVectors(env: Env, repo: string, path: string, startLines: number[]): Promise<void> {
  if (startLines.length === 0) return;
  const ids = await Promise.all(startLines.map((sl) => chunkId(repo, path, sl)));
  await env.CODE_INDEX.deleteByIds(ids);
}

export async function queryChunks(
  env: Env,
  repo: string,
  queryVector: number[],
  topK: number = RETRIEVAL_TOP_K
): Promise<RetrievedChunk[]> {
  const res = await env.CODE_INDEX.query(queryVector, {
    topK,
    filter: { repo } as any,
    returnMetadata: true,
  });
  return (res.matches ?? []).map((m: any) => ({
    path: String(m.metadata?.path ?? ""),
    start_line: Number(m.metadata?.start_line ?? 0),
    end_line: Number(m.metadata?.end_line ?? 0),
    snippet: String(m.metadata?.snippet ?? ""),
    score: m.score ?? 0,
  }));
}

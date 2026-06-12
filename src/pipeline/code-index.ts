// Lazy + TTL code-index pipeline: builds (or refreshes) a per-repo semantic
// index in Vectorize, and retrieves relevant code chunks for a query.
//
// Build is triggered off the response hot path (via ctx.waitUntil by the
// caller). A cold repo whose index is still warming returns { status:
// "index_warming" } from retrieveCode, so the classifier falls back to the
// existing directory-tree grounding — never worse than today.
//
// Vectorize/Workers AI access is injected (deps.vec) so the pipeline is testable
// under Miniflare, which has no native emulation for those bindings.

import type { Env, RetrievedChunk } from "../types";
import type { GitHubClient } from "../lib/github";
import { LineWindowChunker, type Chunker, type CodeChunk } from "../lib/chunker";
import { getIndexManifest, putIndexManifest, isIndexFresh } from "../lib/kv";
import * as realVec from "../lib/vectorize";
import { RETRIEVAL_TOP_K } from "../lib/vectorize";

// Big enough to index large single-file apps (e.g. a 460KB admin SPA) — these
// are often the MOST important files to find. They chunk into line-windows like
// any file; embeddings are batched, so a large file does not blow the
// per-invocation subrequest budget.
const MAX_FILE_BYTES = 1_000_000;
const MAX_CHUNKS_PER_REPO = 3000;
const EMBED_BATCH = 100;
const READ_BATCH = 10; // files fetched in parallel per round (bounded subrequest fan-out)
const FILES_PER_SLICE = 15; // files indexed per Worker invocation.

// bge-base-en-v1.5 is an *asymmetric* retrieval model: the query side must carry
// this instruction prefix while documents stay raw. Embedding the bare query (as
// we did originally) leaves recall on the table — the model card prescribes this
// exact string for "searching relevant passages". Stored chunks are embedded
// unprefixed in ensureFreshIndex, so this only changes the query path and needs
// no re-index.
export const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export function formatQueryForEmbedding(query: string): string {
  return BGE_QUERY_PREFIX + query;
}
// Subrequest budget (Free plan cap = 50): 15 reads + ~6 embed + ~6 upsert
// + 2 tree (first slice only) ≈ 29 worst-case, with headroom for retries.

// Natural-language docs (design specs, plans, markdown) match NL queries far
// more strongly than code, crowding actual source out of the top semantic
// results. Keep the CODE index code-only; the classifier still sees docs in the
// authoritative directory listing, so nothing is lost for grounding context.
//
// Beyond docs, three more classes produce noise vectors that dominate retrieval:
// binary assets (an indexed Hebrew-content migration .xlsx matched essentially
// every Hebrew client message), generated/minified bundles + lockfiles, and
// logs/dumps. None carry code semantics worth embedding. Mirror any change here
// in eval/m3/chunker.mjs's isExcluded (guarded by the parity test).
const EXCLUDED_EXTENSIONS =
  /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|tiff?|woff2?|ttf|otf|eot|pdf|xlsx?|docx?|pptx?|zip|tar|t?gz|bz2|rar|7z|mp4|mp3|wav|mov|avi|webm|m4a|ogg|log|dump|diff|csv|tsv)$/i;
const MINIFIED_OR_BUNDLE = /\.(?:min\.(?:js|css)|bundle\.js)$/i;
const EXCLUDED_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "diff.txt",
]);

export function isExcludedFromCodeIndex(path: string): boolean {
  if (/(^|\/)docs\//i.test(path) || /\.(md|markdown|mdx)$/i.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (EXCLUDED_BASENAMES.has(basename)) return true;
  return MINIFIED_OR_BUNDLE.test(path) || EXCLUDED_EXTENSIONS.test(path);
}

// The subset of GitHubClient the pipeline needs (eases testing/typing).
type RepoReader = Pick<GitHubClient, "getRepoTree" | "getRepoTreeDetailed" | "readFile">;

export interface VectorizeDeps {
  embedTexts: typeof realVec.embedTexts;
  upsertChunks: typeof realVec.upsertChunks;
  queryChunks: typeof realVec.queryChunks;
  deleteFileVectors?: typeof realVec.deleteFileVectors;
}

// Pure tree diff: given the manifest's stored path→sha map and the current tree
// (path+sha), classify each path. `changed` = present in the tree with a sha
// that differs from (or is absent in) the baseline; `removed` = baseline paths
// no longer in the tree. An empty/absent sha (e.g. the contents fallback) never
// equals a stored sha, so it always re-embeds — safe over silently skipping.
export function diffTree(
  prevShas: Record<string, string>,
  tree: Array<{ path: string; sha: string }>
): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  const present = new Set<string>();
  for (const { path, sha } of tree) {
    present.add(path);
    if (prevShas[path] !== sha) changed.push(path);
  }
  const removed = Object.keys(prevShas).filter((p) => !present.has(p));
  return { changed, removed };
}

export interface CodeIndexDeps {
  vec?: VectorizeDeps;
  chunker?: Chunker;
  now?: () => number;
  maxChunks?: number;
  maxFileBytes?: number;
  filesPerSlice?: number;
  headSha?: string; // last pushed commit SHA (bookkeeping for applyIncremental)
}

// Read → chunk → embed → upsert a concrete list of files, bounded by the
// subrequest/chunk budgets. Returns the cumulative chunk count plus, per file,
// the start_lines of the chunks actually written — the manifest stores these in
// file_chunks so a later delete can re-derive the exact vector ids. Reused by
// the full build (one slice at a time), the blob-SHA diff, and push updates.
//
// `deps.maxChunks` is the budget of chunks to add in THIS call (the caller
// passes its remaining global budget). Files are read in bounded parallel
// rounds; unreadable/empty/oversized files are skipped, not fatal.
export async function indexFiles(
  env: Env,
  repo: string,
  paths: string[],
  gh: Pick<GitHubClient, "readFile">,
  deps: CodeIndexDeps = {}
): Promise<{ chunksAdded: number; perFileStartLines: Record<string, number[]> }> {
  const vec = deps.vec ?? realVec;
  const chunker = deps.chunker ?? new LineWindowChunker();
  const maxChunks = deps.maxChunks ?? MAX_CHUNKS_PER_REPO;
  const maxFileBytes = deps.maxFileBytes ?? MAX_FILE_BYTES;

  const collected: CodeChunk[] = [];
  const perFileStartLines: Record<string, number[]> = {};

  for (let i = 0; i < paths.length && collected.length < maxChunks; i += READ_BATCH) {
    const batch = paths.slice(i, i + READ_BATCH);
    const files = await Promise.all(batch.map((p) => gh.readFile(repo, p).catch(() => null)));
    for (const file of files) {
      if (!file || !file.content || file.size_bytes > maxFileBytes) continue;
      const starts: number[] = [];
      for (const c of chunker.chunk(file.content, file.path)) {
        if (collected.length >= maxChunks) break;
        collected.push(c);
        starts.push(c.start_line);
      }
      if (starts.length > 0) perFileStartLines[file.path] = starts;
      if (collected.length >= maxChunks) break;
    }
  }

  for (let i = 0; i < collected.length; i += EMBED_BATCH) {
    const batch = collected.slice(i, i + EMBED_BATCH);
    const vectors = await vec.embedTexts(env, batch.map((c) => c.text));
    await vec.upsertChunks(env, repo, batch, vectors);
  }

  return { chunksAdded: collected.length, perFileStartLines };
}

export interface EnsureIndexResult {
  built: boolean;        // a slice ran this invocation (false only when skipped as already-fresh)
  complete: boolean;     // the whole repo is now indexed
  chunk_count: number;   // cumulative chunks indexed so far
  indexed_files: number; // count of files indexed so far
  total_files: number;   // paths.length
}

// Reconcile a manifest's sha/chunk bookkeeping after a slice of changed files was
// (re-)embedded and a slice of files removed. Shared by the periodic diff and the
// push path so the delete logic stays in lockstep. Crucially, for each CHANGED
// file it deletes the vectors of chunks that the prior version had but the new
// one no longer produces (file shrank → orphaned start_lines): vector ids are
// keyed by start_line, so re-embedding the new chunks does NOT overwrite them and
// they would otherwise pollute retrieval forever. Deletes run in parallel.
//
// file_shas/file_chunks are updated ONLY for the paths actually processed, so a
// changed file that wasn't embedded (e.g. left for the next slice) keeps its old
// baseline and is retried rather than blessed as up to date.
async function mergeChangeDeltas(
  env: Env,
  repo: string,
  prevShas: Record<string, string>,
  prevChunks: Record<string, number[]>,
  changed: string[],
  removed: string[],
  perFileStartLines: Record<string, number[]>,
  shaByPath: Map<string, string>,
  callDelete: typeof realVec.deleteFileVectors
): Promise<{ fileShas: Record<string, string>; fileChunks: Record<string, number[]>; chunkCount: number }> {
  const fileShas: Record<string, string> = { ...prevShas };
  const fileChunks: Record<string, number[]> = { ...prevChunks };
  const deletions: Promise<void>[] = [];

  for (const p of removed) {
    deletions.push(callDelete(env, repo, p, prevChunks[p] ?? []));
    delete fileShas[p];
    delete fileChunks[p];
  }
  for (const p of changed) {
    const oldStarts = prevChunks[p] ?? [];
    const newStarts = perFileStartLines[p] ?? [];
    const newSet = new Set(newStarts);
    const stale = oldStarts.filter((s) => !newSet.has(s));
    if (stale.length > 0) deletions.push(callDelete(env, repo, p, stale));
    if (shaByPath.has(p)) fileShas[p] = shaByPath.get(p)!;
    if (newStarts.length > 0) fileChunks[p] = newStarts;
    else delete fileChunks[p]; // changed to empty/unreadable → no chunks remain
  }

  await Promise.all(deletions);
  const chunkCount = Object.values(fileChunks).reduce((n, a) => n + a.length, 0);
  return { fileShas, fileChunks, chunkCount };
}

export async function ensureFreshIndex(
  env: Env,
  repo: string,
  gh: RepoReader,
  deps: CodeIndexDeps = {}
): Promise<EnsureIndexResult> {
  const vec = deps.vec ?? realVec;
  const chunker = deps.chunker ?? new LineWindowChunker();
  const now = deps.now ?? (() => Date.now());
  const maxChunks = deps.maxChunks ?? MAX_CHUNKS_PER_REPO;
  const maxFileBytes = deps.maxFileBytes ?? MAX_FILE_BYTES;

  const manifest = await getIndexManifest(env, repo);
  if (isIndexFresh(manifest, chunker.version, now())) {
    const total = manifest!.paths.length;
    return { built: false, complete: true, chunk_count: manifest!.chunk_count, indexed_files: total, total_files: total };
  }

  // Blob-SHA diff path (the cheap safety net that replaces the full rebuild).
  // When we have a complete, current-chunker manifest WITH a stored sha baseline,
  // re-embed only the files whose git blob SHA changed and delete vectors for
  // files that disappeared. An unchanged repo costs one tree call and zero
  // neurons. A legacy manifest without file_shas falls through to a full rebuild
  // below (the migration), which populates the baseline.
  if (
    manifest &&
    manifest.status === "complete" &&
    manifest.chunker_version === chunker.version &&
    manifest.file_shas
  ) {
    const callDelete = vec.deleteFileVectors ?? realVec.deleteFileVectors;
    // getRepoTreeDetailed throws (not falls back) on API failure, so a transient
    // error can never present as an empty tree that deletes the whole index.
    const tree = (await gh.getRepoTreeDetailed(repo)).filter((t) => !isExcludedFromCodeIndex(t.path));
    const { changed, removed } = diffTree(manifest.file_shas, tree);

    // Bound work per invocation (subrequest cap) — process at most one slice of
    // changed + removed files. When the change set exceeds a slice we leave
    // fetched_at stale so the next tick re-diffs and drains the rest, exactly
    // like the sliced full build. Only the processed paths get their baseline
    // updated, so nothing is blessed as indexed without actually being embedded.
    const filesPerSlice = deps.filesPerSlice ?? FILES_PER_SLICE;
    const changedSlice = changed.slice(0, filesPerSlice);
    const removedSlice = removed.slice(0, filesPerSlice);
    const drained = changedSlice.length === changed.length && removedSlice.length === removed.length;

    const { perFileStartLines } = await indexFiles(env, repo, changedSlice, gh, {
      vec, chunker, maxChunks, maxFileBytes,
    });
    const shaByPath = new Map(tree.map((t) => [t.path, t.sha]));
    const { fileShas, fileChunks, chunkCount } = await mergeChangeDeltas(
      env, repo, manifest.file_shas, manifest.file_chunks ?? {},
      changedSlice, removedSlice, perFileStartLines, shaByPath, callDelete
    );
    const paths = Object.keys(fileShas);

    await putIndexManifest(env, repo, {
      repo,
      // Advance fetched_at (restart the TTL window) only once the whole diff is
      // reconciled; otherwise stay stale so the next tick continues.
      fetched_at: drained ? new Date(now()).toISOString() : manifest.fetched_at,
      chunk_count: chunkCount,
      chunker_version: chunker.version,
      status: "complete",
      cursor: paths.length,
      paths,
      file_shas: fileShas,
      file_chunks: fileChunks,
      head_sha: manifest.head_sha,
    });

    return {
      built: changedSlice.length > 0 || removedSlice.length > 0,
      complete: drained,
      chunk_count: chunkCount,
      indexed_files: paths.length,
      total_files: tree.length,
    };
  }

  const filesPerSlice = deps.filesPerSlice ?? FILES_PER_SLICE;

  // Resume an in-progress build, or start a fresh one. A "building" manifest with
  // a stale chunker_version is discarded (treated as a fresh build).
  let paths: string[];
  let cursor: number;
  let chunkCount: number;
  let fileChunks: Record<string, number[]>;
  let fileShas: Record<string, string>;
  if (manifest && manifest.status === "building" && manifest.chunker_version === chunker.version) {
    paths = manifest.paths;
    cursor = manifest.cursor;
    chunkCount = manifest.chunk_count;
    fileChunks = manifest.file_chunks ?? {};
    fileShas = manifest.file_shas ?? {};
  } else {
    // Fresh full build: capture the blob-SHA baseline up front (cheap — same tree
    // call) so the diff path can take over once this build completes.
    const detailed = (await gh.getRepoTreeDetailed(repo)).filter((t) => !isExcludedFromCodeIndex(t.path));
    paths = detailed.map((t) => t.path);
    fileShas = Object.fromEntries(detailed.map((t) => [t.path, t.sha]));
    cursor = 0;
    chunkCount = 0;
    fileChunks = {};
  }

  // Index ONE bounded slice of files this invocation, staying under the
  // subrequest cap. Order is preserved; a single unreadable file is skipped, not
  // fatal. Stop early if the global chunk cap is reached.
  const sliceEnd = Math.min(cursor + filesPerSlice, paths.length);
  const slicePaths = paths.slice(cursor, sliceEnd);
  const { chunksAdded, perFileStartLines } = await indexFiles(env, repo, slicePaths, gh, {
    vec,
    chunker,
    maxChunks: maxChunks - chunkCount,
    maxFileBytes,
  });
  Object.assign(fileChunks, perFileStartLines);

  chunkCount += chunksAdded;
  cursor = sliceEnd;
  const complete = cursor >= paths.length || chunkCount >= maxChunks;

  await putIndexManifest(env, repo, {
    repo,
    fetched_at: new Date(now()).toISOString(),
    chunk_count: chunkCount,
    chunker_version: chunker.version,
    status: complete ? "complete" : "building",
    cursor,
    paths,
    file_shas: fileShas,
    file_chunks: fileChunks,
  });

  return {
    built: true,
    complete,
    chunk_count: chunkCount,
    indexed_files: cursor,
    total_files: paths.length,
  };
}

// Push-driven incremental update. Re-embeds the changed files and deletes
// vectors for removed ones, then merges the new state into the manifest WITHOUT
// advancing fetched_at — so the periodic blob-SHA diff (the safety net) still
// fires on schedule and self-heals anything a push under-reported.
//
// `changed`/`removed` come from the push payload (caller already filtered the
// repo + branch). file_shas is updated ONLY for the paths actually touched: a
// file that changed but wasn't in the push list keeps its old baseline sha, so
// the next diff re-embeds it rather than blessing a sha for content we never
// indexed. Bails to a normal ensureFreshIndex kickoff when there's no complete
// manifest with a sha baseline to merge into (e.g. legacy/never-indexed repos).
export async function applyIncremental(
  env: Env,
  repo: string,
  gh: RepoReader,
  changed: string[],
  removed: string[],
  deps: CodeIndexDeps = {}
): Promise<EnsureIndexResult> {
  const vec = deps.vec ?? realVec;
  const chunker = deps.chunker ?? new LineWindowChunker();
  const now = deps.now ?? (() => Date.now());
  const maxChunks = deps.maxChunks ?? MAX_CHUNKS_PER_REPO;
  const maxFileBytes = deps.maxFileBytes ?? MAX_FILE_BYTES;

  const manifest = await getIndexManifest(env, repo);
  if (!manifest || manifest.status !== "complete" || !manifest.file_shas) {
    // No baseline to merge into — kick off (or resume) a normal build, which
    // populates the new fields and lets future pushes go incremental.
    return ensureFreshIndex(env, repo, gh, deps);
  }

  const callDelete = vec.deleteFileVectors ?? realVec.deleteFileVectors;
  const changedFiltered = changed.filter((p) => !isExcludedFromCodeIndex(p));

  // Read the tree FIRST (for the changed files' current blob SHAs). It throws on
  // API failure, aborting before any mutation rather than leaving a half-applied
  // index. Used only to stamp the baseline for paths the push reported.
  const tree = await gh.getRepoTreeDetailed(repo);
  const shaByPath = new Map(tree.map((t) => [t.path, t.sha]));

  const { perFileStartLines } = await indexFiles(env, repo, changedFiltered, gh, {
    vec, chunker, maxChunks, maxFileBytes,
  });
  const { fileShas, fileChunks, chunkCount } = await mergeChangeDeltas(
    env, repo, manifest.file_shas, manifest.file_chunks ?? {},
    changedFiltered, removed, perFileStartLines, shaByPath, callDelete
  );
  const paths = Object.keys(fileShas);

  await putIndexManifest(env, repo, {
    repo,
    fetched_at: manifest.fetched_at, // UNCHANGED — keep the TTL safety net armed
    chunk_count: chunkCount,
    chunker_version: manifest.chunker_version,
    status: "complete",
    cursor: paths.length,
    paths,
    file_shas: fileShas,
    file_chunks: fileChunks,
    head_sha: deps.headSha ?? manifest.head_sha,
  });

  return {
    built: changedFiltered.length > 0 || removed.length > 0,
    complete: true,
    chunk_count: chunkCount,
    indexed_files: paths.length,
    total_files: paths.length,
  };
}

export type RetrieveResult =
  | { status: "ok"; chunks: RetrievedChunk[] }
  | { status: "index_warming" };

export async function retrieveCode(
  env: Env,
  repo: string,
  query: string,
  deps: CodeIndexDeps = {}
): Promise<RetrieveResult> {
  const vec = deps.vec ?? realVec;

  const manifest = await getIndexManifest(env, repo);
  if (!manifest || manifest.status !== "complete") return { status: "index_warming" };

  const [queryVector] = await vec.embedTexts(env, [formatQueryForEmbedding(query)]);
  // A missing/empty embedding (malformed AI response) must not become a bogus
  // zero-vector query — report no matches instead.
  if (!queryVector || queryVector.length === 0) return { status: "ok", chunks: [] };
  const chunks = await vec.queryChunks(env, repo, queryVector, RETRIEVAL_TOP_K);
  return { status: "ok", chunks };
}

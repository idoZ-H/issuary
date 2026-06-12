import type { Env } from "../types";
import { GitHubClient } from "../lib/github";
import { ensureFreshIndex, type EnsureIndexResult } from "./code-index";
import { getIndexManifest, isIndexFresh, listClients } from "../lib/kv";
import { CHUNKER_VERSION } from "../lib/chunker";

const MAX_SLICES_PER_TICK = 2;   // bounded so one cron tick stays under the subrequest cap
const MAX_REPOS_PER_TICK = 2;    // bound total work per tick across repos

export interface IndexMaintenanceDeps {
  buildGh?: (env: Env, repo: string) => Promise<GitHubClient>;
  ensureFreshIndexFn?: (env: Env, repo: string, gh: GitHubClient) => Promise<EnsureIndexResult>;
  now?: () => number;
}

// Cron-driven background indexer. Lists code-index manifests, and for each repo
// whose index is NOT fresh — still "building", OR "complete" but stale (TTL
// expired or built by an older chunker version) — advances it by up to
// MAX_SLICES_PER_TICK slices this tick (bounded to respect the per-invocation
// subrequest cap). For a stale "complete" manifest with a sha baseline,
// ensureFreshIndex now runs the cheap blob-SHA DIFF (re-embedding only changed
// files, deleting removed ones) rather than a full rebuild — a chunker-version
// bump or a legacy manifest without file_shas still forces a full rebuild.
// Reliable because Cloudflare's scheduler invokes the Worker directly — no
// fragile Worker-to-self fetch.
export async function runIndexMaintenance(env: Env, deps: IndexMaintenanceDeps = {}): Promise<void> {
  const buildGh = deps.buildGh ?? ((e: Env, r: string) => GitHubClient.forRepo(e, r));
  const ensureFn = deps.ensureFreshIndexFn ?? ((e: Env, r: string, gh: GitHubClient) => ensureFreshIndex(e, r, gh));
  const nowMs = deps.now ? deps.now() : Date.now();

  const listed = await env.CODE_INDEX_META.list();
  const stale: string[] = [];
  for (const key of listed.keys) {
    const m = await getIndexManifest(env, key.name);
    // A fresh, complete, current-version index needs no work. Everything else
    // (building, or stale/old-version complete) gets advanced/rebuilt.
    if (m && !isIndexFresh(m, CHUNKER_VERSION, nowMs)) stale.push(key.name);
  }

  // Bootstrap: discover semantic-enabled projects that have NO manifest yet
  // (brand-new repos) and add them to the work set, so attaching a repo
  // eventually indexes even if the proactive kickoff on add was dropped. Manifest
  // keys and project.repo are both the "owner/repo" string, so they compare
  // like-for-like. Bounded by MAX_REPOS_PER_TICK below.
  const manifestRepos = new Set(listed.keys.map((k) => k.name));
  const enabledRepos = new Set<string>();
  for (const { record } of await listClients(env)) {
    for (const p of record.projects) {
      if (p.semantic_enabled !== false) enabledRepos.add(p.repo);
    }
  }
  for (const repo of enabledRepos) {
    if (!manifestRepos.has(repo)) stale.push(repo);
  }

  let reposDone = 0;
  for (const repo of stale) {
    if (reposDone >= MAX_REPOS_PER_TICK) break;
    reposDone++;
    let gh: GitHubClient;
    try {
      gh = await buildGh(env, repo);
    } catch (e) {
      console.warn("code_index_maint_failed", { repo, error: (e as Error).message });
      continue;
    }
    for (let i = 0; i < MAX_SLICES_PER_TICK; i++) {
      let r: EnsureIndexResult;
      try {
        r = await ensureFn(env, repo, gh);
      } catch (e) {
        console.warn("code_index_maint_failed", { repo, error: (e as Error).message });
        break;
      }
      console.log("code_index_maint_progress", { repo, indexed: r.indexed_files, total: r.total_files, complete: r.complete, chunks: r.chunk_count });
      if (r.complete || !r.built) break;
    }
  }
}

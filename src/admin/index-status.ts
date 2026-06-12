// Derives per-repo semantic-index status from the CodeIndexManifest KV. Pure +
// injectable so it tests without Miniflare bindings for AI/Vectorize.

import type { Env, CodeIndexManifest } from "../types";
import { getIndexManifest, isIndexFresh, listClients, listClientsCached } from "../lib/kv";
import { CHUNKER_VERSION } from "../lib/chunker";

export type IndexState = "missing" | "building" | "stale" | "complete" | "disabled";

export interface IndexStatusRow {
  repo: string;
  clients: Array<{ tg_user_id: number; client_name: string; project_id: string }>;
  semantic_enabled: boolean;
  state: IndexState;
  indexed_files: number;
  total_files: number;
  chunk_count: number;
  chunker_version: string | null;
  version_stale: boolean;
  fetched_at: string | null;
  age_ms: number | null;
}

export function deriveIndexState(
  manifest: CodeIndexManifest | null,
  chunkerVersion: string,
  nowMs: number,
  semanticEnabled: boolean,
): IndexState {
  if (!semanticEnabled) return "disabled";
  if (!manifest) return "missing";
  if (manifest.status === "building") return "building";
  if (isIndexFresh(manifest, chunkerVersion, nowMs)) return "complete";
  return "stale";
}

const STATE_ORDER: Record<IndexState, number> = {
  building: 0, stale: 1, missing: 2, disabled: 3, complete: 4,
};

export interface IndexStatusDeps {
  listClients?: typeof listClients;
  getManifest?: (env: Env, repo: string) => Promise<CodeIndexManifest | null>;
  now?: () => number;
}

export async function collectIndexStatuses(env: Env, deps: IndexStatusDeps = {}): Promise<IndexStatusRow[]> {
  // Dashboard-only page: use the cached read so refreshes don't each spend a
  // CLIENTS.list() op. Cron has its own loop and does not call this.
  const list = await (deps.listClients ?? listClientsCached)(env);
  const getManifest = deps.getManifest ?? getIndexManifest;
  const nowMs = (deps.now ?? Date.now)();

  // Group projects by repo (a repo may be referenced by several clients).
  const byRepo = new Map<string, { semantic: boolean; clients: IndexStatusRow["clients"] }>();
  for (const { tg_user_id, record } of list) {
    for (const p of record.projects) {
      const entry = byRepo.get(p.repo) ?? { semantic: false, clients: [] };
      entry.clients.push({ tg_user_id, client_name: record.name, project_id: p.id });
      if (p.semantic_enabled !== false) entry.semantic = true;
      byRepo.set(p.repo, entry);
    }
  }

  // Read manifests in parallel (one KV get per repo) — mirrors the issues page.
  const rows = await Promise.all(
    [...byRepo.entries()].map(async ([repo, entry]) => {
      const manifest = await getManifest(env, repo).catch(() => null);
      const state = deriveIndexState(manifest, CHUNKER_VERSION, nowMs, entry.semantic);
      return {
        repo,
        clients: entry.clients,
        semantic_enabled: entry.semantic,
        state,
        indexed_files: manifest?.cursor ?? 0,
        total_files: manifest?.paths.length ?? 0,
        chunk_count: manifest?.chunk_count ?? 0,
        chunker_version: manifest?.chunker_version ?? null,
        version_stale: manifest != null && manifest.chunker_version !== CHUNKER_VERSION,
        fetched_at: manifest?.fetched_at ?? null,
        age_ms: manifest ? Math.max(0, nowMs - Date.parse(manifest.fetched_at)) : null,
      } satisfies IndexStatusRow;
    })
  );

  rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.repo.localeCompare(b.repo));
  return rows;
}

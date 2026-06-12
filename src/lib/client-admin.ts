// Client Administration — the deep module behind which both admin surfaces sit.
//
// The Telegram `/admin` commands (src/handlers/admin.ts) and the web dashboard
// (src/admin/pages/clients.ts) are two adapters over the same client/project
// mutations. This module owns the shared core of every mutation: input
// validation, repo-conflict detection, the active/default invariant repair, the
// KV read-modify-write, and the side effects (menu sync, index-build kickoff).
// Each surface keeps only its own presentation — Hebrew Telegram replies vs HTML
// redirects — and maps the structured results below to that presentation.
//
// Side effects are injected (`syncMenu`, `kickoffIndexBuild`) so the module owns
// "after this mutation, do X" from one place while staying testable and letting
// the Telegram surface reuse its own TelegramClient instance.

import type { Env, ClientRecord, ProjectRecord } from "../types";
import { getClient, putClient, deleteClient, slugFromRepo, canonicalizeRepo } from "./kv";
import { TelegramClient } from "./telegram";
import { syncChatMenu } from "./menu";
import { getInstallationToken } from "./github";

export type ValidateRepoFn = (env: Env, repo: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

// Default: a repo is valid iff the GitHub App can mint an installation token for
// it (i.e. the repo exists and the App is installed there).
export const defaultValidateRepo: ValidateRepoFn = async (env, repo) => {
  try {
    await getInstallationToken(env, repo);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

export { slugFromRepo };

export function isValidRepoFormat(repo: string): boolean {
  return /^[^\s/]+\/[^\s/]+$/.test(repo);
}

export interface ClientAdminDeps {
  validateRepo?: ValidateRepoFn;
  // Called after mutations that can change the project COUNT (or the default),
  // so the per-chat Telegram command menu stays in sync. Failures are caught —
  // a menu-sync hiccup must never roll back a persisted mutation.
  syncMenu?: (env: Env, record: ClientRecord) => Promise<void>;
  // Best-effort proactive index build for a newly attached / re-enabled repo.
  kickoffIndexBuild?: (repo: string) => void;
}

const defaultSyncMenu = async (env: Env, record: ClientRecord): Promise<void> => {
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  await syncChatMenu(tg, record);
};

async function runSyncMenu(env: Env, record: ClientRecord, deps: ClientAdminDeps): Promise<void> {
  try {
    await (deps.syncMenu ?? defaultSyncMenu)(env, record);
  } catch (e) {
    console.warn("syncChatMenu_failed", { tgUserId: record.telegram_chat_id, error: (e as Error).message });
  }
}

const nowIso = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────
// createClient
// ─────────────────────────────────────────────────────────────

export type CreateClientResult =
  | { ok: true; record: ClientRecord }
  | { ok: false; reason: "client_exists" | "invalid_repo" | "repo_validation_failed"; message?: string };

export interface CreateClientArgs {
  tgUserId: number;
  name: string;
  repo: string;
  projectId?: string;
  projectNameHe?: string;
  semanticEnabled: boolean;
}

export async function createClient(env: Env, args: CreateClientArgs, deps: ClientAdminDeps = {}): Promise<CreateClientResult> {
  const repo = canonicalizeRepo(args.repo);
  if (!isValidRepoFormat(repo)) return { ok: false, reason: "invalid_repo" };
  if (await getClient(env, args.tgUserId)) return { ok: false, reason: "client_exists" };

  const validation = await (deps.validateRepo ?? defaultValidateRepo)(env, repo);
  if (!validation.ok) return { ok: false, reason: "repo_validation_failed", message: validation.reason };

  const projectId = args.projectId || slugFromRepo(repo);
  const now = nowIso();
  const project: ProjectRecord = {
    id: projectId,
    name_he: args.projectNameHe || projectId,
    repo,
    created_at: now,
    semantic_enabled: args.semanticEnabled,
  };
  const record: ClientRecord = {
    name: args.name, telegram_chat_id: args.tgUserId, active: true, created_at: now,
    projects: [project], active_project_id: projectId, default_project_id: projectId,
  };
  await putClient(env, args.tgUserId, record);
  await runSyncMenu(env, record, deps);
  if (args.semanticEnabled) deps.kickoffIndexBuild?.(repo);
  return { ok: true, record };
}

// ─────────────────────────────────────────────────────────────
// addProject
// ─────────────────────────────────────────────────────────────

export type AddProjectResult =
  | { ok: true; record: ClientRecord; project: ProjectRecord; wasMulti: boolean; becameMultiFirstTime: boolean }
  | { ok: false; reason: "client_not_found" | "invalid_repo" | "id_conflict" | "repo_conflict" | "repo_validation_failed"; message?: string; conflictId?: string };

export interface AddProjectArgs {
  repo: string;
  projectId?: string;
  nameHe?: string;
  semanticEnabled: boolean;
  // When set, and this add crosses the client from single- to multi-project for
  // the first time, the module stamps `welcomed_multi_at` so the Telegram surface
  // can send its one-time onboarding DM. The web surface leaves this unset.
  markWelcomedOnFirstMulti?: boolean;
}

export async function addProject(env: Env, tgUserId: number, args: AddProjectArgs, deps: ClientAdminDeps = {}): Promise<AddProjectResult> {
  const repo = canonicalizeRepo(args.repo);
  if (!isValidRepoFormat(repo)) return { ok: false, reason: "invalid_repo" };
  const existing = await getClient(env, tgUserId);
  if (!existing) return { ok: false, reason: "client_not_found" };

  const projectId = args.projectId || slugFromRepo(repo);
  if (existing.projects.some((p) => p.id === projectId)) return { ok: false, reason: "id_conflict", conflictId: projectId };
  const repoConflict = existing.projects.find((p) => p.repo === repo);
  if (repoConflict) return { ok: false, reason: "repo_conflict", conflictId: repoConflict.id };

  const validation = await (deps.validateRepo ?? defaultValidateRepo)(env, repo);
  if (!validation.ok) return { ok: false, reason: "repo_validation_failed", message: validation.reason };

  const now = nowIso();
  const project: ProjectRecord = {
    id: projectId, name_he: args.nameHe || projectId, repo, created_at: now, semantic_enabled: args.semanticEnabled,
  };
  const wasMulti = existing.projects.length > 1;
  const becameMultiFirstTime = !!args.markWelcomedOnFirstMulti && !wasMulti && existing.welcomed_multi_at === undefined;
  const updated: ClientRecord = { ...existing, projects: [...existing.projects, project] };
  if (becameMultiFirstTime) updated.welcomed_multi_at = now;

  await putClient(env, tgUserId, updated);
  await runSyncMenu(env, updated, deps);
  if (args.semanticEnabled) deps.kickoffIndexBuild?.(repo);
  return { ok: true, record: updated, project, wasMulti, becameMultiFirstTime };
}

// ─────────────────────────────────────────────────────────────
// removeClient / removeProject
// ─────────────────────────────────────────────────────────────

// deleteClient is idempotent and both surfaces report success unconditionally,
// so there's nothing to read or branch on.
export async function removeClient(env: Env, tgUserId: number): Promise<void> {
  await deleteClient(env, tgUserId);
}

export type RemoveProjectResult =
  | { ok: true; record: ClientRecord; removed: ProjectRecord; activeChanged: boolean; newActive: ProjectRecord }
  | { ok: false; reason: "client_not_found" | "only_project" | "project_not_found" };

export async function removeProject(env: Env, tgUserId: number, projectId: string, deps: ClientAdminDeps = {}): Promise<RemoveProjectResult> {
  const existing = await getClient(env, tgUserId);
  if (!existing) return { ok: false, reason: "client_not_found" };
  if (existing.projects.length <= 1) return { ok: false, reason: "only_project" };
  const removed = existing.projects.find((p) => p.id === projectId);
  if (!removed) return { ok: false, reason: "project_not_found" };

  const remaining = existing.projects.filter((p) => p.id !== projectId);
  // Invariant repair: active/default must always point at a surviving project.
  let active = existing.active_project_id;
  let def = existing.default_project_id;
  if (active === projectId) active = remaining.find((p) => p.id === def)?.id ?? remaining[0]!.id;
  if (def === projectId) def = remaining[0]!.id;

  const updated: ClientRecord = { ...existing, projects: remaining, active_project_id: active, default_project_id: def };
  await putClient(env, tgUserId, updated);
  await runSyncMenu(env, updated, deps);
  const activeChanged = existing.active_project_id === projectId;
  const newActive = updated.projects.find((p) => p.id === updated.active_project_id)!;
  return { ok: true, record: updated, removed, activeChanged, newActive };
}

// ─────────────────────────────────────────────────────────────
// setDefaultProject / setActiveProject
// ─────────────────────────────────────────────────────────────

export type SetProjectPointerResult =
  | { ok: true; record: ClientRecord }
  | { ok: false; reason: "client_not_found" | "project_not_found" };

// Pointer flips only — neither changes the project COUNT, so the per-chat
// command menu (MULTI vs SINGLE) is unaffected and no menu sync is needed. (The
// Telegram surface still re-syncs after set-default for its own reasons; that
// lives in the adapter, not here, so the web surface incurs no Telegram call.)
export async function setDefaultProject(env: Env, tgUserId: number, projectId: string): Promise<SetProjectPointerResult> {
  const existing = await getClient(env, tgUserId);
  if (!existing) return { ok: false, reason: "client_not_found" };
  if (!existing.projects.some((p) => p.id === projectId)) return { ok: false, reason: "project_not_found" };
  const updated: ClientRecord = { ...existing, default_project_id: projectId };
  await putClient(env, tgUserId, updated);
  return { ok: true, record: updated };
}

export async function setActiveProject(env: Env, tgUserId: number, projectId: string): Promise<SetProjectPointerResult> {
  const existing = await getClient(env, tgUserId);
  if (!existing) return { ok: false, reason: "client_not_found" };
  if (!existing.projects.some((p) => p.id === projectId)) return { ok: false, reason: "project_not_found" };
  const updated: ClientRecord = { ...existing, active_project_id: projectId };
  await putClient(env, tgUserId, updated);
  return { ok: true, record: updated };
}

// ─────────────────────────────────────────────────────────────
// setProjectRepo
// ─────────────────────────────────────────────────────────────

export type SetProjectRepoResult =
  | { ok: true; record: ClientRecord; oldRepo: string; newRepo: string }
  | {
      ok: false;
      reason: "client_not_found" | "project_not_found" | "no_change" | "repo_conflict" | "invalid_repo" | "repo_validation_failed";
      message?: string; conflictId?: string; available?: string[];
    };

export async function setProjectRepo(env: Env, tgUserId: number, projectId: string, newRepoRaw: string, deps: ClientAdminDeps = {}): Promise<SetProjectRepoResult> {
  const newRepo = canonicalizeRepo(newRepoRaw);
  if (!isValidRepoFormat(newRepo)) return { ok: false, reason: "invalid_repo" };
  const existing = await getClient(env, tgUserId);
  if (!existing) return { ok: false, reason: "client_not_found" };
  const project = existing.projects.find((p) => p.id === projectId);
  if (!project) return { ok: false, reason: "project_not_found", available: existing.projects.map((p) => p.id) };
  if (project.repo === newRepo) return { ok: false, reason: "no_change" };
  const conflict = existing.projects.find((p) => p.id !== projectId && p.repo === newRepo);
  if (conflict) return { ok: false, reason: "repo_conflict", conflictId: conflict.id };

  const validation = await (deps.validateRepo ?? defaultValidateRepo)(env, newRepo);
  if (!validation.ok) return { ok: false, reason: "repo_validation_failed", message: validation.reason };

  const oldRepo = project.repo;
  const updated: ClientRecord = {
    ...existing,
    projects: existing.projects.map((p) => (p.id === projectId ? { ...p, repo: newRepo } : p)),
  };
  await putClient(env, tgUserId, updated);
  return { ok: true, record: updated, oldRepo, newRepo };
}

// ─────────────────────────────────────────────────────────────
// setProjectSemantic
// ─────────────────────────────────────────────────────────────

export type SetProjectSemanticResult =
  | { ok: true; record: ClientRecord; project: ProjectRecord; enabled: boolean }
  | { ok: false; reason: "client_not_found" | "project_not_found"; available?: string[] };

export async function setProjectSemantic(env: Env, tgUserId: number, projectId: string, enabled: boolean, deps: ClientAdminDeps = {}): Promise<SetProjectSemanticResult> {
  const existing = await getClient(env, tgUserId);
  if (!existing) return { ok: false, reason: "client_not_found" };
  const project = existing.projects.find((p) => p.id === projectId);
  if (!project) return { ok: false, reason: "project_not_found", available: existing.projects.map((p) => p.id) };
  const updated: ClientRecord = {
    ...existing,
    projects: existing.projects.map((p) => (p.id === projectId ? { ...p, semantic_enabled: enabled } : p)),
  };
  await putClient(env, tgUserId, updated);
  // Re-enabling proactively kicks off the index build; cron + lazy ingest back it up.
  if (enabled) deps.kickoffIndexBuild?.(project.repo);
  return { ok: true, record: updated, project, enabled };
}

// ─────────────────────────────────────────────────────────────
// updateClient (top-level fields)
// ─────────────────────────────────────────────────────────────

export type UpdateClientResult =
  | { ok: true; record: ClientRecord }
  | { ok: false; reason: "client_not_found" };

export async function updateClient(
  env: Env,
  tgUserId: number,
  fields: { name?: string; active: boolean; shadowMode: boolean },
): Promise<UpdateClientResult> {
  const existing = await getClient(env, tgUserId);
  if (!existing) return { ok: false, reason: "client_not_found" };
  const updated: ClientRecord = {
    ...existing,
    name: fields.name?.trim() || existing.name,
    active: fields.active,
    shadow_mode: fields.shadowMode,
  };
  await putClient(env, tgUserId, updated);
  return { ok: true, record: updated };
}

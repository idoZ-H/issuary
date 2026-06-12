import type {
  Env, ClientRecord, ProjectRecord, RepoContext, RecentActivity,
  PendingClassification, IssueToChat, AdminRecord, ConversationHistory, ConversationTurn,
  CodeIndexManifest,
} from "../types";

const RECENT_TTL_S = 60;
const PENDING_TTL_S = 30 * 60;
const REPO_CONTEXT_TTL_S = 6 * 60 * 60;
// 6h: the periodic freshness check is now a cheap blob-SHA diff (one tree call,
// zero neurons for an unchanged repo), not a full re-embed — so the old 7d throttle
// is obsolete. Pushes keep the index current in real time; this TTL only bounds how
// fast the cron safety-net reconciles anything a push missed (truncated/forced
// pushes, dropped webhook deliveries, orphaned vectors). Floor is the cron period
// (*/30); 6h ⇒ ~4 cheap re-checks/day/repo. Matches REPO_CONTEXT_TTL_S.
export const CODE_INDEX_TTL_S = 6 * 60 * 60;
const ISSUE_TO_CHAT_TTL_S = 90 * 24 * 60 * 60;
const DEDUP_TTL_S = 60 * 60;

// Canonical form of an "owner/repo" string. GitHub owner/repo names are
// case-INSENSITIVE but case-PRESERVING, so the same repo can arrive under
// different casing from different sources (admin types "idoZ-H/Foo", another
// client types "idoz-h/foo", GitHub webhooks send the repo's actual display
// case in `full_name`). Every repo→KV-key lookup (the shared CODE_INDEX_META
// manifest, REPO_CONTEXT, ISSUE_TO_CHAT) is a plain case-sensitive key match, so
// without a single canonical form the same repo splits into multiple keys and
// gets indexed once per casing. Canonicalize at every entry point: client read
// (normalizeClient), client write (client-admin), and both GitHub webhooks.
export function canonicalizeRepo(repo: string): string {
  return repo.trim().toLowerCase();
}

// Single source of truth for repo → project-id slugging, used both by the
// legacy-record normalizer below and by the client-admin mutation module.
export function slugFromRepo(repo: string): string {
  // "workfluxs/acme-core" → "acme-core"
  const idx = repo.indexOf("/");
  const tail = idx >= 0 ? repo.slice(idx + 1) : repo;
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function withSemanticDefault(p: ProjectRecord): ProjectRecord {
  const canonRepo = canonicalizeRepo(p.repo);
  const repoFixed = canonRepo === p.repo ? p : { ...p, repo: canonRepo };
  return repoFixed.semantic_enabled === undefined ? { ...repoFixed, semantic_enabled: true } : repoFixed;
}

function normalizeClient(raw: any): ClientRecord {
  if (Array.isArray(raw.projects)) {
    const rec = raw as ClientRecord;
    return { ...rec, projects: rec.projects.map(withSemanticDefault) };
  }
  const id = slugFromRepo(raw.repo);
  const project: ProjectRecord = {
    id,
    name_he: raw.name,
    repo: canonicalizeRepo(raw.repo),
    created_at: raw.created_at,
    semantic_enabled: true,
  };
  return {
    name: raw.name,
    telegram_chat_id: raw.telegram_chat_id,
    active: raw.active,
    created_at: raw.created_at,
    shadow_mode: raw.shadow_mode,
    projects: [project],
    active_project_id: id,
    default_project_id: id,
  };
}

export function getActiveProject(client: ClientRecord): ProjectRecord {
  const found = client.projects.find((p) => p.id === client.active_project_id);
  if (!found) {
    // Should never happen — defensive fallback to first project.
    return client.projects[0]!;
  }
  return found;
}

export async function getClient(env: Env, tgUserId: number): Promise<ClientRecord | null> {
  const raw = await env.CLIENTS.get<any>(String(tgUserId), "json");
  if (!raw) return null;
  return normalizeClient(raw);
}

export async function putClient(env: Env, tgUserId: number, record: ClientRecord): Promise<void> {
  await env.CLIENTS.put(String(tgUserId), JSON.stringify(record));
  await invalidateClientsCache(env);
}

export async function deleteClient(env: Env, tgUserId: number): Promise<void> {
  await env.CLIENTS.delete(String(tgUserId));
  await invalidateClientsCache(env);
}

// Dashboard-only cached read of the full client list. The admin pages call this
// on every render; without a cache, repeated refreshes each spend one of the
// free-tier's 1,000 daily CLIENTS.list() ops and eventually 500 the whole
// dashboard ("KV list() limit exceeded for the day"). A 60s snapshot in the
// dedicated cache namespace collapses a burst of refreshes into one list().
// Cron/push/Telegram deliberately keep calling listClients() directly — they run
// infrequently and want fresh data for indexing decisions. Mutations invalidate
// the snapshot so admin edits still appear immediately.
const CLIENTS_CACHE_KEY = "clients:all:v1";
const CLIENTS_CACHE_TTL_S = 60;

type ClientList = Array<{ tg_user_id: number; record: ClientRecord }>;

export async function listClientsCached(env: Env): Promise<ClientList> {
  const cached = await env.ISSUE_LIST_CACHE.get<ClientList>(CLIENTS_CACHE_KEY, "json").catch(() => null);
  if (cached) return cached;
  const fresh = await listClients(env);
  await env.ISSUE_LIST_CACHE.put(CLIENTS_CACHE_KEY, JSON.stringify(fresh), { expirationTtl: CLIENTS_CACHE_TTL_S }).catch(() => {});
  return fresh;
}

async function invalidateClientsCache(env: Env): Promise<void> {
  await env.ISSUE_LIST_CACHE.delete(CLIENTS_CACHE_KEY).catch(() => {});
}

// True for Cloudflare's free-tier KV daily-quota errors (e.g. "KV list() limit
// exceeded for the day."), so callers can degrade to a clear banner instead of a
// generic 500. Resets at 00:00 UTC; removed by upgrading to the paid plan.
export function isKvQuotaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /limit exceeded/i.test(msg);
}

export async function listClients(env: Env): Promise<Array<{ tg_user_id: number; record: ClientRecord }>> {
  // KV.list() returns at most 1000 keys per call; pagination via cursor is not
  // handled here. Revisit at T28 if the admin client list ever exceeds that.
  const list = await env.CLIENTS.list();
  const records = await Promise.all(
    list.keys.map((key) => env.CLIENTS.get<any>(key.name, "json"))
  );
  const out: Array<{ tg_user_id: number; record: ClientRecord }> = [];
  for (let i = 0; i < list.keys.length; i++) {
    const record = records[i];
    const key = list.keys[i];
    if (record && key) out.push({ tg_user_id: Number(key.name), record: normalizeClient(record) });
  }
  return out;
}

export async function isAdmin(env: Env, tgUserId: number): Promise<boolean> {
  const r = await env.ADMINS.get<AdminRecord>(String(tgUserId), "json");
  return r?.role === "admin";
}

export async function putAdmin(env: Env, tgUserId: number): Promise<void> {
  await env.ADMINS.put(String(tgUserId), JSON.stringify({ role: "admin" } satisfies AdminRecord));
}

export async function deleteAdmin(env: Env, tgUserId: number): Promise<void> {
  await env.ADMINS.delete(String(tgUserId));
}

export async function listAdmins(env: Env): Promise<number[]> {
  const list = await env.ADMINS.list();
  const out: number[] = [];
  for (const key of list.keys) {
    const n = Number(key.name);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

export async function getRepoContext(env: Env, repo: string): Promise<RepoContext | null> {
  return env.REPO_CONTEXT.get<RepoContext>(repo, "json");
}

export async function putRepoContext(env: Env, repo: string, ctx: RepoContext): Promise<void> {
  await env.REPO_CONTEXT.put(repo, JSON.stringify(ctx), { expirationTtl: REPO_CONTEXT_TTL_S });
}

// Code-index manifest. No KV TTL — freshness is derived from fetched_at by
// isIndexFresh() so a stale manifest still tells us to rebuild rather than
// vanishing (which would read as "never indexed").
export async function getIndexManifest(env: Env, repo: string): Promise<CodeIndexManifest | null> {
  return env.CODE_INDEX_META.get<CodeIndexManifest>(repo, "json");
}

export async function putIndexManifest(env: Env, repo: string, manifest: CodeIndexManifest): Promise<void> {
  await env.CODE_INDEX_META.put(repo, JSON.stringify(manifest));
}

// Force-reindex: dropping the manifest makes isIndexFresh() return false, so the
// next ensureFreshIndex starts a fresh build from cursor 0 (re-fetching the tree).
export async function deleteIndexManifest(env: Env, repo: string): Promise<void> {
  await env.CODE_INDEX_META.delete(repo);
}

export function isIndexFresh(manifest: CodeIndexManifest | null, chunkerVersion: string, nowMs: number): boolean {
  if (!manifest) return false;
  if (manifest.status !== "complete") return false;
  if (manifest.chunker_version !== chunkerVersion) return false;
  const age = nowMs - Date.parse(manifest.fetched_at);
  return Number.isFinite(age) && age >= 0 && age < CODE_INDEX_TTL_S * 1000;
}

function recentKey(tgUserId: number, projectId: string): string {
  return `${tgUserId}:${projectId}`;
}

export async function getRecentActivity(
  env: Env,
  tgUserId: number,
  projectId: string
): Promise<RecentActivity | null> {
  const fresh = await env.RECENT_ACTIVITY.get<RecentActivity>(recentKey(tgUserId, projectId), "json");
  if (fresh) return fresh;
  // Legacy fallback: pre-migration key was just String(tgUserId). Safe to read,
  // never write back. The 60-second TTL ensures legacy entries are gone within
  // a minute of deploy.
  return env.RECENT_ACTIVITY.get<RecentActivity>(String(tgUserId), "json");
}

export async function putRecentActivity(
  env: Env,
  tgUserId: number,
  projectId: string,
  ra: RecentActivity
): Promise<void> {
  await env.RECENT_ACTIVITY.put(recentKey(tgUserId, projectId), JSON.stringify(ra), {
    expirationTtl: RECENT_TTL_S,
  });
}

function pendingKey(tgUserId: number, projectId: string): string {
  return `${tgUserId}:${projectId}`;
}

export async function getPending(
  env: Env,
  tgUserId: number,
  projectId: string
): Promise<PendingClassification | null> {
  const fresh = await env.PENDING_CLASSIFICATION.get<PendingClassification>(
    pendingKey(tgUserId, projectId),
    "json"
  );
  if (fresh) return fresh;
  // Legacy fallback: pre-migration key was just String(tgUserId). Safe to read,
  // never write back. The 30-minute TTL ensures legacy entries are gone within
  // 30 minutes of deploy.
  return env.PENDING_CLASSIFICATION.get<PendingClassification>(String(tgUserId), "json");
}

export async function putPending(
  env: Env,
  tgUserId: number,
  projectId: string,
  p: PendingClassification
): Promise<void> {
  await env.PENDING_CLASSIFICATION.put(pendingKey(tgUserId, projectId), JSON.stringify(p), {
    expirationTtl: PENDING_TTL_S,
  });
}

export async function deletePending(env: Env, tgUserId: number, projectId: string): Promise<void> {
  await env.PENDING_CLASSIFICATION.delete(pendingKey(tgUserId, projectId));
  // Best-effort: also delete legacy un-suffixed key if it exists.
  await env.PENDING_CLASSIFICATION.delete(String(tgUserId));
}

const HISTORY_TTL_S = 30 * 60;
const HISTORY_MAX_TURNS = 5;

function historyKey(tgUserId: number, projectId: string): string {
  return `${tgUserId}:${projectId}`;
}

export async function getHistory(
  env: Env,
  tgUserId: number,
  projectId: string,
): Promise<ConversationHistory | null> {
  return env.CONVERSATION_HISTORY.get<ConversationHistory>(historyKey(tgUserId, projectId), "json");
}

export async function appendTurn(
  env: Env,
  tgUserId: number,
  projectId: string,
  turn: { role: "user" | "assistant"; text: string },
): Promise<void> {
  const key = historyKey(tgUserId, projectId);
  const existing = await env.CONVERSATION_HISTORY.get<ConversationHistory>(key, "json");
  const now = new Date().toISOString();
  const nextTurn: ConversationTurn = { ...turn, ts: now };
  const turns = [...(existing?.turns ?? []), nextTurn].slice(-HISTORY_MAX_TURNS);
  const next: ConversationHistory = { turns, updated_at: now };
  await env.CONVERSATION_HISTORY.put(key, JSON.stringify(next), { expirationTtl: HISTORY_TTL_S });
}

export async function getIssueChat(env: Env, repo: string, issueNumber: number): Promise<IssueToChat | null> {
  return env.ISSUE_TO_CHAT.get<IssueToChat>(`${repo}/${issueNumber}`, "json");
}

export async function putIssueChat(env: Env, repo: string, issueNumber: number, ic: IssueToChat): Promise<void> {
  await env.ISSUE_TO_CHAT.put(`${repo}/${issueNumber}`, JSON.stringify(ic), { expirationTtl: ISSUE_TO_CHAT_TTL_S });
}

export async function dedupCheck(env: Env, key: string): Promise<boolean> {
  // Best-effort dedup. Workers KV has no compare-and-swap and is eventually
  // consistent across colos, so two concurrent calls with the same key MAY both
  // observe the absent state and both return false. Callers (T19/T22/T27) must
  // ensure the protected action is idempotent or self-deduping (e.g., via
  // content hashing on the issue body before posting to GitHub).
  const existed = await env.DEDUP.get(key);
  if (existed) return true;
  await env.DEDUP.put(key, "1", { expirationTtl: DEDUP_TTL_S });
  return false;
}

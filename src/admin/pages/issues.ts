// Recent issues feed — cross-project view of incoming feedback.
//
// Data sources:
//   - ISSUE_TO_CHAT KV: keyed by "<repo>/<issue_number>", value links back to
//     the originating Telegram user/chat (+ optional langsmith_run_id).
//   - Live GitHub: per-issue state (open/closed), title, labels — cached in
//     ISSUE_LIST_CACHE for 60 seconds.
//   - CLIENTS KV: to resolve tg_user_id to client name + project display.

import type { Env, IssueToChat, ClientRecord } from "../../types";
import { listClientsCached } from "../../lib/kv";
import { getInstallationToken } from "../../lib/github";
import { html, type HtmlFragment, htmlResponse } from "../html";
import { renderPage, type NavKey } from "../layout";
import type { CurrentAdmin } from "../auth";

const NAV: NavKey = "issues";
const ISSUE_LIMIT = 50;
const CACHE_TTL_S = 60;

interface CachedIssueState {
  title: string;
  state: "open" | "closed";
  labels: string[];
  html_url: string;
  updated_at: string;
}

interface IssueRow {
  repo: string;
  issue_number: number;
  client_tg_user_id: number;
  client_name: string;
  project_id: string;
  langsmith_run_id?: string;
  // From cache or GitHub. Null if unreachable.
  state: CachedIssueState | null;
  // Approximate created_at: KV expiration is created_at + 90 days, so we
  // subtract to get a stable created_at proxy. Unix ms.
  created_at_approx_ms: number;
}

interface CacheBoundFetcher {
  (repo: string, issueNumber: number): Promise<CachedIssueState | null>;
}

function relativeTime(now: number, then_ms: number): string {
  const diffSec = Math.max(0, Math.floor((now - then_ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(then_ms).toISOString().slice(0, 10);
}

function projectFromRepo(client: ClientRecord, repo: string): string {
  const p = client.projects.find((p) => p.repo === repo);
  return p?.id ?? repo;
}

function typeBadgeFromLabels(labels: string[]): HtmlFragment {
  // Issue labels come from suggested_labels; the classifier tends to include
  // one of bug/feature/question. Show the first matching label as the type.
  const types = ["bug", "feature", "question", "out_of_scope", "chitchat"];
  const t = labels.find((l) => types.includes(l.toLowerCase()));
  if (!t) return html`<span class="badge">-</span>`;
  return html`<span class="badge">${t.toLowerCase()}</span>`;
}

function langsmithLink(env: Env, runId: string | undefined): HtmlFragment {
  if (!runId) return html``;
  const org = env.LANGSMITH_ORG_SLUG;
  if (!org) return html`<span class="link-muted" title="LANGSMITH_ORG_SLUG not set">trace</span>`;
  const project = env.LANGSMITH_PROJECT ?? "feedback-bot";
  // Project UUID is stable for the feedback-bot project; we use the slug too.
  const url = `https://smith.langchain.com/o/${encodeURIComponent(org)}/projects/p/${encodeURIComponent(project)}/r/${encodeURIComponent(runId)}`;
  return html`<a class="link" href="${url}" target="_blank" rel="noopener">trace</a>`;
}

async function makeCachedFetcher(env: Env): Promise<CacheBoundFetcher> {
  const tokensByRepo = new Map<string, Promise<string | null>>();

  return async (repo, issueNumber) => {
    const cacheKey = `${repo}/${issueNumber}`;
    const cached = await env.ISSUE_LIST_CACHE.get<CachedIssueState>(cacheKey, "json");
    if (cached) return cached;

    if (!tokensByRepo.has(repo)) {
      tokensByRepo.set(repo, getInstallationToken(env, repo).catch((e) => {
        console.warn("admin_issues_token_failed", { repo, error: (e as Error).message });
        return null;
      }));
    }
    const token = await tokensByRepo.get(repo)!;
    if (!token) return null;
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
        headers: {
          "authorization": `Bearer ${token}`,
          "accept": "application/vnd.github+json",
          "user-agent": "workfluxs-feedback-bot",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!res.ok) return null;
      const json = await res.json<any>();
      const state: CachedIssueState = {
        title: String(json.title ?? ""),
        state: json.state === "closed" ? "closed" : "open",
        labels: Array.isArray(json.labels) ? json.labels.map((l: any) => typeof l === "string" ? l : String(l.name ?? "")) : [],
        html_url: String(json.html_url ?? `https://github.com/${repo}/issues/${issueNumber}`),
        updated_at: String(json.updated_at ?? ""),
      };
      await env.ISSUE_LIST_CACHE.put(cacheKey, JSON.stringify(state), { expirationTtl: CACHE_TTL_S });
      return state;
    } catch (e) {
      console.warn("admin_issues_fetch_failed", { repo, issueNumber, error: (e as Error).message });
      return null;
    }
  };
}

// Exported for tests so we can inject a fake fetcher and skip GitHub network.
export interface IssuesDeps {
  fetcher?: CacheBoundFetcher;
}

export async function renderIssuesFeed(
  env: Env,
  currentAdmin: CurrentAdmin,
  filter: { clientTgUserId?: number },
  deps: IssuesDeps = {},
): Promise<Response> {
  const list = await env.ISSUE_TO_CHAT.list({ limit: 1000 });
  // KV.list returns { name, expiration?, metadata? }. We sort by expiration
  // desc to approximate "most recently created first" since all keys share
  // a 90-day TTL.
  const entries = list.keys
    .filter((k) => typeof k.expiration === "number")
    .sort((a, b) => (b.expiration ?? 0) - (a.expiration ?? 0))
    .slice(0, ISSUE_LIMIT);

  const clientsArr = await listClientsCached(env);
  const clientsByTg = new Map<number, ClientRecord>();
  for (const c of clientsArr) clientsByTg.set(c.tg_user_id, c.record);

  const fetcher = deps.fetcher ?? await makeCachedFetcher(env);
  const now = Date.now();
  const ttlMs = 90 * 24 * 60 * 60 * 1000;

  const rowsPromises = entries.map(async (entry) => {
    const idx = entry.name.lastIndexOf("/");
    if (idx < 0) return null;
    const repo = entry.name.slice(0, idx);
    const issueNumber = Number(entry.name.slice(idx + 1));
    if (!Number.isFinite(issueNumber)) return null;
    const mapping = await env.ISSUE_TO_CHAT.get<IssueToChat>(entry.name, "json");
    if (!mapping) return null;
    if (filter.clientTgUserId && mapping.tg_user_id !== filter.clientTgUserId) return null;

    const client = clientsByTg.get(mapping.tg_user_id);
    const state = await fetcher(repo, issueNumber);
    const row: IssueRow = {
      repo,
      issue_number: issueNumber,
      client_tg_user_id: mapping.tg_user_id,
      client_name: client?.name ?? `tg:${mapping.tg_user_id}`,
      project_id: client ? projectFromRepo(client, repo) : repo,
      langsmith_run_id: mapping.langsmith_run_id,
      state,
      created_at_approx_ms: ((entry.expiration ?? 0) * 1000) - ttlMs,
    };
    return row;
  });
  const rows = (await Promise.all(rowsPromises)).filter((r): r is IssueRow => r !== null);

  const body = html`
    <h2 class="title">Recent issues</h2>
    <p class="subtitle">Up to ${ISSUE_LIMIT} most recent feedback issues across all projects · 90-day window</p>
    <div class="toolbar">
      <form method="get" action="/admin/issues" class="form-row">
        <div class="field">
          <label for="client">filter by client</label>
          <select class="select" id="client" name="client" onchange="this.form.submit()">
            <option value="">all clients</option>
            ${clientsArr.map((c) => html`
              <option value="${c.tg_user_id}" ${filter.clientTgUserId === c.tg_user_id ? "selected" : ""}>${c.record.name} (${c.tg_user_id})</option>
            `)}
          </select>
        </div>
        ${filter.clientTgUserId ? html`<a class="btn btn-ghost btn-sm" href="/admin/issues">clear filter</a>` : html``}
      </form>
    </div>
    ${rows.length === 0
      ? html`<div class="empty">no issues yet${filter.clientTgUserId ? html` for this client` : html``}</div>`
      : html`
        <table>
          <thead>
            <tr>
              <th>created</th>
              <th>client</th>
              <th>project</th>
              <th>type</th>
              <th>state</th>
              <th>title</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => html`
              <tr>
                <td>${relativeTime(now, r.created_at_approx_ms)}</td>
                <td>${r.client_name}</td>
                <td>${r.project_id}</td>
                <td>${r.state ? typeBadgeFromLabels(r.state.labels) : html`<span class="badge">-</span>`}</td>
                <td>${r.state
                  ? (r.state.state === "open"
                      ? html`<span class="badge badge-ok">open</span>`
                      : html`<span class="badge">closed</span>`)
                  : html`<span class="badge badge-warn" title="GitHub fetch failed">⚠ stale</span>`}</td>
                <td>${r.state?.title ?? `#${r.issue_number}`}</td>
                <td class="actions">
                  <a class="link" href="${r.state?.html_url ?? `https://github.com/${r.repo}/issues/${r.issue_number}`}" target="_blank" rel="noopener">gh</a>
                  ${langsmithLink(env, r.langsmith_run_id)}
                </td>
              </tr>
            `)}
          </tbody>
        </table>
      `
    }
  `;
  return htmlResponse(renderPage({ title: "Issues", nav: NAV, currentAdmin, body }));
}

// Global semantic code-index status page + force-rebuild handler.

import type { Env } from "../../types";
import { html, type HtmlFragment, htmlResponse } from "../html";
import { renderPage, type NavKey } from "../layout";
import { redirect, type CurrentAdmin } from "../auth";
import { collectIndexStatuses, type IndexStatusRow, type IndexState } from "../index-status";
import { fetchUsage, type UsageSnapshot } from "../usage";
import { deleteIndexManifest } from "../../lib/kv";

const NAV: NavKey = "index";

export interface IndexStatusPageDeps {
  collect?: (env: Env) => Promise<IndexStatusRow[]>;
  usage?: (env: Env) => Promise<UsageSnapshot>;
}

function relAge(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function num(n: number): string { return n.toLocaleString("en-US"); }

function stateBadge(state: IndexState): HtmlFragment {
  switch (state) {
    case "complete": return html`<span class="badge badge-ok">complete</span>`;
    case "building": return html`<span class="badge badge-warn">building</span>`;
    case "stale":    return html`<span class="badge badge-warn">stale</span>`;
    case "missing":  return html`<span class="badge">missing</span>`;
    case "disabled": return html`<span class="badge">disabled</span>`;
  }
}

function progressCell(r: IndexStatusRow): HtmlFragment {
  if (r.total_files === 0) return html`—`;
  const pct = Math.min(100, Math.round((r.indexed_files / r.total_files) * 100));
  return html`
    <div>${r.indexed_files} / ${r.total_files}</div>
    <div style="height:4px;background:var(--border);border-radius:2px;margin-top:3px;overflow:hidden;">
      <div style="height:100%;width:${pct}%;background:var(--ok);"></div>
    </div>`;
}

function usagePanel(u: UsageSnapshot): HtmlFragment {
  if (!u.ok) {
    return html`<div class="flash" style="margin-bottom:16px;">Workers AI / KV usage unavailable — ${u.error ?? "not configured"}.</div>`;
  }
  const pct = Math.min(100, Math.round((u.neurons_today / u.neuron_daily_free) * 100));
  const over = u.neurons_today >= u.neuron_daily_free;
  return html`
    <div class="card" style="margin-bottom:16px;"><div class="card-body">
      <h3 class="title" style="font-size:13px;">Operational · last 7 days</h3>
      <p class="subtitle">Workers AI neurons today: <strong style="color:${over ? "var(--destructive)" : "var(--foreground)"}">${num(Math.round(u.neurons_today))}</strong> / ${num(u.neuron_daily_free)} free</p>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;max-width:360px;">
        <div style="height:100%;width:${pct}%;background:${over ? "var(--destructive)" : "var(--ok)"};"></div>
      </div>
      <div class="form-row" style="margin-top:14px;gap:24px;align-items:flex-start;">
        <div>
          <label>neurons / day</label>
          <table style="font-size:11px;"><tbody>
            ${u.neurons_by_day.map((d) => html`<tr><td style="padding:2px 8px 2px 0;">${d.date}</td><td class="num" style="padding:2px 0;">${num(Math.round(d.neurons))}</td></tr>`)}
          </tbody></table>
        </div>
        <div>
          <label>KV ops (7d)</label>
          <table style="font-size:11px;"><tbody>
            <tr><td style="padding:2px 8px 2px 0;">read</td><td class="num">${num(u.kv_ops.read)}</td></tr>
            <tr><td style="padding:2px 8px 2px 0;">write</td><td class="num">${num(u.kv_ops.write)}</td></tr>
            <tr><td style="padding:2px 8px 2px 0;">list</td><td class="num">${num(u.kv_ops.list)}</td></tr>
            <tr><td style="padding:2px 8px 2px 0;">delete</td><td class="num">${num(u.kv_ops.delete)}</td></tr>
          </tbody></table>
        </div>
      </div>
    </div></div>`;
}

export async function renderIndexStatusPage(
  env: Env, currentAdmin: CurrentAdmin, deps: IndexStatusPageDeps = {},
  flash?: { kind: "error" | "ok"; message: string },
): Promise<Response> {
  const rows = await (deps.collect ?? collectIndexStatuses)(env);
  const usage = await (deps.usage ?? fetchUsage)(env);
  const anyBuilding = rows.some((r) => r.state === "building");

  const body = html`
    <h2 class="title">Code index status</h2>
    <p class="subtitle">${rows.length} ${rows.length === 1 ? "repo" : "repos"}${anyBuilding ? html` · auto-refreshing while building` : html``}</p>
    <p class="subtitle" style="max-width:760px;line-height:1.6;">
      <strong>How freshness works:</strong> code pushes update the index <strong>incrementally</strong> — only changed files are re-embedded, in near real-time. A cron safety-net re-checks each repo on a <strong>6-hour TTL</strong> (a cheap blob-SHA diff, not a full rebuild) to reconcile anything a push missed. “age” is the time since the index was last verified — after the TTL a repo turns <strong>stale</strong> and the next cron tick (every 30&nbsp;min) or client message runs the diff. Use <strong>rebuild</strong> to force a full re-index now.
    </p>
    ${usagePanel(usage)}
    ${rows.length === 0
      ? html`<div class="empty">no repos configured</div>`
      : html`
        <table>
          <thead><tr><th>repo</th><th>clients</th><th title="missing = no index yet · building = indexing in progress · stale = older than the freshness TTL or built by an old chunker · complete = fresh · disabled = semantic off">state</th><th>progress</th><th>chunks</th><th title="chunker version this index was built with; 'old' means the chunker changed and a rebuild is needed">chunker</th><th title="time since the index was last verified — pushes update it incrementally; a cron safety-net re-checks on the freshness TTL">age</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => html`
              <tr>
                <td>${r.repo}</td>
                <td>${r.clients.map((c) => c.client_name + " / " + c.project_id).join(", ")}</td>
                <td>${stateBadge(r.state)}</td>
                <td>${progressCell(r)}</td>
                <td class="num">${r.chunk_count ? num(r.chunk_count) : "—"}</td>
                <td>${r.chunker_version ?? "—"}${r.version_stale ? html` <span class="badge badge-warn">old</span>` : html``}</td>
                <td>${r.state === "stale" ? html`<span class="badge badge-warn">${relAge(r.age_ms)}</span>` : html`${relAge(r.age_ms)}`}</td>
                <td>
                  <form method="post" action="/admin/index/rebuild" style="display:inline;" onsubmit="return confirm('Rebuild index for ${r.repo}?')">
                    <input type="hidden" name="repo" value="${r.repo}">
                    <button class="btn btn-ghost btn-sm" type="submit" ${r.state === "disabled" || r.state === "building" ? "disabled" : ""}>rebuild</button>
                  </form>
                </td>
              </tr>`)}
          </tbody>
        </table>`}
  `;
  return htmlResponse(renderPage({
    title: "Index status", nav: NAV, currentAdmin, body, flash,
    refreshSeconds: anyBuilding ? 5 : undefined,
  }));
}

export interface RebuildDeps {
  resetIndex?: (env: Env, repo: string) => Promise<void>;
  kickoffIndexBuild?: (repo: string) => void;
}

export async function handleRebuildIndex(env: Env, req: Request, deps: RebuildDeps = {}): Promise<Response> {
  const form = await req.formData();
  const repo = String(form.get("repo") ?? "").trim();
  if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) return redirect("/admin/index-status");
  const reset = deps.resetIndex ?? deleteIndexManifest;
  await reset(env, repo);
  deps.kickoffIndexBuild?.(repo);
  return redirect("/admin/index-status");
}

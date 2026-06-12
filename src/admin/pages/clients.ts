// Clients page — list view, detail view, new form, and all mutation handlers.
// Mirrors the six /admin Telegram commands but as HTML.

import type { Env, ClientRecord, ProjectRecord, CodeIndexManifest } from "../../types";
import { getClient, listClientsCached, getIndexManifest } from "../../lib/kv";
import { deriveIndexState, type IndexState } from "../index-status";
import { CHUNKER_VERSION } from "../../lib/chunker";
import {
  createClient, addProject, removeClient, removeProject,
  setActiveProject, setDefaultProject, setProjectRepo, setProjectSemantic, updateClient,
  isValidRepoFormat, type ClientAdminDeps, type ValidateRepoFn,
} from "../../lib/client-admin";
import { html, type HtmlFragment, htmlResponse } from "../html";
import { renderPage, type NavKey } from "../layout";
import { redirect, type CurrentAdmin } from "../auth";

const NAV: NavKey = "clients";

export type { ValidateRepoFn };

export interface ClientsDeps {
  validateRepo?: ValidateRepoFn;
  // Best-effort proactive index build for a newly attached / re-enabled repo.
  // Production wires this to continueIndexBuild under ctx.waitUntil; cron + lazy
  // ingest are the fallbacks if the kickoff is dropped.
  kickoffIndexBuild?: (repo: string) => void;
}

// Map this surface's deps onto the shared mutation module. syncMenu is left to
// the module default (it builds its own TelegramClient from env) — matching the
// dashboard's prior behaviour of constructing a client per mutation.
function caDeps(deps: ClientsDeps): ClientAdminDeps {
  return { validateRepo: deps.validateRepo, kickoffIndexBuild: deps.kickoffIndexBuild };
}

// ─────────────────────────────────────────────────────────────
// List view
// ─────────────────────────────────────────────────────────────

function clientStatusBadge(c: ClientRecord): HtmlFragment {
  if (!c.active) return html`<span class="badge">inactive</span>`;
  if (c.shadow_mode) return html`<span class="badge badge-warn">shadow</span>`;
  return html`<span class="badge badge-ok">active</span>`;
}

function projectsSummary(c: ClientRecord): HtmlFragment {
  const items = c.projects.map((p) => {
    const isActive = p.id === c.active_project_id;
    return isActive ? html`<strong>${p.id}*</strong>` : html`${p.id}`;
  });
  return html`${items.flatMap((el, i) => i === 0 ? [el] : [html`, `, el])}`;
}

export async function renderClientsList(
  env: Env,
  currentAdmin: CurrentAdmin,
  flash?: { kind: "error" | "ok"; message: string },
): Promise<Response> {
  const list = await listClientsCached(env);
  const projectCount = list.reduce((n, c) => n + c.record.projects.length, 0);

  const body = html`
    <div class="toolbar">
      <input class="input flex" type="search" placeholder="search by name, tg_user_id, repo" oninput="filterTable(this)" autocomplete="off">
      <a class="btn" href="/admin/clients/new">+ add client</a>
    </div>
    <h2 class="title">Clients</h2>
    <p class="subtitle">${list.length} ${list.length === 1 ? "client" : "clients"} · ${projectCount} ${projectCount === 1 ? "project" : "projects"}</p>
    ${list.length === 0
      ? html`<div class="empty">no clients yet — <a class="link" href="/admin/clients/new">add the first one</a></div>`
      : html`
        <table id="clients-table">
          <thead>
            <tr><th>tg_user_id</th><th>name</th><th>projects</th><th>active project</th><th>status</th><th></th></tr>
          </thead>
          <tbody>
            ${list.map((c) => html`
              <tr>
                <td><a class="link" href="/admin/clients/${c.tg_user_id}">${c.tg_user_id}</a></td>
                <td>${c.record.name}</td>
                <td>${projectsSummary(c.record)}</td>
                <td>${c.record.active_project_id}</td>
                <td>${clientStatusBadge(c.record)}</td>
                <td><a class="link link-muted" href="/admin/clients/${c.tg_user_id}">edit</a></td>
              </tr>
            `)}
          </tbody>
        </table>
      `
    }
    <script>
      function filterTable(input) {
        const q = input.value.trim().toLowerCase();
        const rows = document.querySelectorAll("#clients-table tbody tr");
        rows.forEach((tr) => {
          tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? "" : "none";
        });
      }
    </script>
  `;
  return htmlResponse(renderPage({ title: "Clients", nav: NAV, currentAdmin, body, flash }));
}

// ─────────────────────────────────────────────────────────────
// New client form
// ─────────────────────────────────────────────────────────────

function renderNewClientForm(opts: {
  currentAdmin: CurrentAdmin;
  values?: Record<string, string>;
  error?: string;
}): Response {
  const v = opts.values ?? {};
  const body = html`
    <h2 class="title">Add client</h2>
    <p class="subtitle">The Telegram bot validates the repo against the installed GitHub App before saving.</p>
    ${opts.error ? html`<div class="flash flash-error">${opts.error}</div>` : html``}
    <form method="post" action="/admin/clients/new">
      <div class="field">
        <label for="tg_user_id">telegram user id</label>
        <input class="input" style="width:100%;" id="tg_user_id" name="tg_user_id" type="number" required value="${v.tg_user_id ?? ""}" autocomplete="off">
      </div>
      <div class="field">
        <label for="name">name</label>
        <input class="input" style="width:100%;" id="name" name="name" type="text" required value="${v.name ?? ""}" autocomplete="off">
      </div>
      <div class="field">
        <label for="repo">repo (owner/repo)</label>
        <input class="input" style="width:100%;" id="repo" name="repo" type="text" required value="${v.repo ?? ""}" autocomplete="off" pattern="[^/]+/[^/]+">
      </div>
      <div class="form-row">
        <div class="field">
          <label for="project_id">project id (optional, autoslug from repo)</label>
          <input class="input" style="width:100%;" id="project_id" name="project_id" type="text" value="${v.project_id ?? ""}" autocomplete="off">
        </div>
        <div class="field">
          <label for="project_name_he">project name for telegram menu (optional)</label>
          <input class="input" style="width:100%;" id="project_name_he" name="project_name_he" type="text" value="${v.project_name_he ?? ""}" autocomplete="off">
        </div>
      </div>
      <div class="field" style="flex:0 0 auto;margin-top:8px;">
        <label><input type="checkbox" name="semantic_enabled" checked> semantic code search</label>
      </div>
      <div class="actions" style="margin-top:16px;">
        <button class="btn" type="submit">Create</button>
        <a class="btn btn-ghost" href="/admin/clients">Cancel</a>
      </div>
    </form>
  `;
  return htmlResponse(renderPage({ title: "Add client", nav: NAV, currentAdmin: opts.currentAdmin, body }),
    opts.error ? { status: 422 } : {});
}

export async function handleNewClientGet(currentAdmin: CurrentAdmin): Promise<Response> {
  return renderNewClientForm({ currentAdmin });
}

export async function handleNewClientPost(
  env: Env,
  req: Request,
  currentAdmin: CurrentAdmin,
  deps: ClientsDeps = {},
): Promise<Response> {
  const form = await req.formData();
  const values = {
    tg_user_id: String(form.get("tg_user_id") ?? "").trim(),
    name: String(form.get("name") ?? "").trim(),
    repo: String(form.get("repo") ?? "").trim(),
    project_id: String(form.get("project_id") ?? "").trim(),
    project_name_he: String(form.get("project_name_he") ?? "").trim(),
  };
  const tgUserId = Number(values.tg_user_id);
  if (!Number.isFinite(tgUserId) || tgUserId <= 0) {
    return renderNewClientForm({ currentAdmin, values, error: "Telegram user ID must be a positive number." });
  }
  if (!values.name) {
    return renderNewClientForm({ currentAdmin, values, error: "Name is required." });
  }
  if (!isValidRepoFormat(values.repo)) {
    return renderNewClientForm({ currentAdmin, values, error: "Repo must be in the form owner/repo." });
  }

  const semanticEnabled = form.get("semantic_enabled") !== null;
  const r = await createClient(env, {
    tgUserId, name: values.name, repo: values.repo,
    projectId: values.project_id || undefined,
    projectNameHe: values.project_name_he || undefined,
    semanticEnabled,
  }, caDeps(deps));
  if (!r.ok) {
    if (r.reason === "client_exists") {
      return renderNewClientForm({ currentAdmin, values, error: `Client ${tgUserId} already exists. Edit it from the list.` });
    }
    if (r.reason === "repo_validation_failed") {
      return renderNewClientForm({
        currentAdmin, values,
        error: `Repo validation failed: ${r.message}. Check that the repo exists and the GitHub App is installed on it.`,
      });
    }
    return renderNewClientForm({ currentAdmin, values, error: "Repo must be in the form owner/repo." });
  }
  return redirect(`/admin/clients/${tgUserId}`);
}

// ─────────────────────────────────────────────────────────────
// Client detail view
// ─────────────────────────────────────────────────────────────

function indexCell(p: ProjectRecord, manifest: CodeIndexManifest | null): HtmlFragment {
  const state: IndexState = deriveIndexState(manifest, CHUNKER_VERSION, Date.now(), p.semantic_enabled !== false);
  const badge =
    state === "complete" ? html`<span class="badge badge-ok">complete</span>` :
    state === "building" ? html`<span class="badge badge-warn">building</span>` :
    state === "stale" ? html`<span class="badge badge-warn">stale</span>` :
    state === "disabled" ? html`<span class="badge">—</span>` :
    html`<span class="badge">missing</span>`;
  if (state === "building" && manifest) return html`${badge} ${manifest.cursor} / ${manifest.paths.length}`;
  return badge;
}

function projectRow(tgUserId: number, c: ClientRecord, p: ProjectRecord, manifest: CodeIndexManifest | null): HtmlFragment {
  const isActive = p.id === c.active_project_id;
  const isDefault = p.id === c.default_project_id;
  const onlyProject = c.projects.length === 1;
  const semanticOn = p.semantic_enabled !== false;
  return html`
    <tr>
      <td>${p.id}${isActive ? html` <span class="badge badge-ok">active</span>` : html``}${isDefault ? html` <span class="badge">default</span>` : html``}</td>
      <td>${p.name_he}</td>
      <td>${p.repo}</td>
      <td>
        <form method="post" action="/admin/clients/${tgUserId}/projects/${p.id}/repo" class="form-row">
          <input class="input" name="repo" type="text" pattern="[^/]+/[^/]+" value="${p.repo}" required>
          <button class="btn btn-ghost btn-sm" type="submit">save</button>
        </form>
      </td>
      <td>
        ${semanticOn ? html`<span class="badge badge-ok">on</span>` : html`<span class="badge">off</span>`}
        <form method="post" action="/admin/clients/${tgUserId}/projects/${p.id}/semantic" style="display:inline;">
          <input type="hidden" name="enabled" value="${semanticOn ? "off" : "on"}">
          <button class="btn btn-ghost btn-sm" type="submit">${semanticOn ? "disable" : "enable"}</button>
        </form>
      </td>
      <td>${indexCell(p, manifest)}</td>
      <td>
        <div class="actions">
          ${!isActive ? html`<form method="post" action="/admin/clients/${tgUserId}/active-project" style="display:inline;"><input type="hidden" name="project_id" value="${p.id}"><button class="btn btn-ghost btn-sm" type="submit">set active</button></form>` : html``}
          ${!isDefault ? html`<form method="post" action="/admin/clients/${tgUserId}/default-project" style="display:inline;"><input type="hidden" name="project_id" value="${p.id}"><button class="btn btn-ghost btn-sm" type="submit">set default</button></form>` : html``}
          ${!onlyProject ? html`
            <form method="post" action="/admin/clients/${tgUserId}/projects/${p.id}/delete" style="display:inline;" onsubmit="return confirm('Remove project ${p.id}?')">
              <button class="btn btn-danger btn-sm" type="submit">remove</button>
            </form>
          ` : html``}
        </div>
      </td>
    </tr>
  `;
}

export async function renderClientDetail(
  env: Env,
  tgUserId: number,
  currentAdmin: CurrentAdmin,
  flash?: { kind: "error" | "ok"; message: string },
): Promise<Response> {
  const c = await getClient(env, tgUserId);
  if (!c) {
    return htmlResponse(renderPage({
      title: "Not found", nav: NAV, currentAdmin,
      body: html`<h2 class="title">Client ${tgUserId} not found</h2><p><a class="link" href="/admin/clients">back to clients</a></p>`,
    }), { status: 404 });
  }

  const body = html`
    <div class="card-header" style="margin:-18px -18px 18px -18px;border-bottom:1px solid var(--border);">
      <div>
        <h2 class="title">${c.name}</h2>
        <p class="subtitle">tg_user_id ${tgUserId} · created ${c.created_at.slice(0, 10)}</p>
      </div>
      <a class="link link-muted" href="/admin/clients">← back to clients</a>
    </div>

    <h3 class="title" style="font-size:13px;">Settings</h3>
    <form method="post" action="/admin/clients/${tgUserId}/update" class="form-row" style="margin-bottom:12px;">
      <div class="field">
        <label for="name">name</label>
        <input class="input" id="name" name="name" type="text" value="${c.name}" required>
      </div>
      <div class="field" style="flex:0 0 auto;">
        <label>active</label>
        <input type="checkbox" name="active" ${c.active ? "checked" : ""}>
      </div>
      <div class="field" style="flex:0 0 auto;">
        <label>shadow mode</label>
        <input type="checkbox" name="shadow_mode" ${c.shadow_mode ? "checked" : ""}>
      </div>
      <button class="btn" type="submit">save</button>
    </form>
    <form method="post" action="/admin/clients/${tgUserId}/delete" onsubmit="return confirm('Delete client ${c.name} and all projects? This cannot be undone.')" style="margin-bottom:24px;">
      <button class="btn btn-danger btn-sm" type="submit">delete client</button>
    </form>

    <h3 class="title" style="font-size:13px;">Projects</h3>
    <table>
      <thead>
        <tr><th>id</th><th>name_he</th><th>repo (current)</th><th>change repo</th><th>semantic</th><th>index</th><th></th></tr>
      </thead>
      <tbody>
        ${await Promise.all(c.projects.map(async (p) => projectRow(tgUserId, c, p, await getIndexManifest(env, p.repo).catch(() => null))))}
      </tbody>
    </table>

    <h3 class="title" style="font-size:13px; margin-top:24px;">Add project</h3>
    <form method="post" action="/admin/clients/${tgUserId}/projects" class="form-row">
      <div class="field">
        <label for="np_id">project id (optional)</label>
        <input class="input" id="np_id" name="project_id" type="text" autocomplete="off">
      </div>
      <div class="field">
        <label for="np_repo">repo (owner/repo)</label>
        <input class="input" id="np_repo" name="repo" type="text" required pattern="[^/]+/[^/]+" autocomplete="off">
      </div>
      <div class="field">
        <label for="np_name">name for telegram menu (optional)</label>
        <input class="input" id="np_name" name="name_he" type="text" autocomplete="off">
      </div>
      <div class="field" style="flex:0 0 auto;">
        <label><input type="checkbox" name="semantic_enabled" checked> semantic code search</label>
      </div>
      <button class="btn" type="submit">add project</button>
    </form>
  `;
  return htmlResponse(renderPage({ title: c.name, nav: NAV, currentAdmin, body, flash }));
}

// ─────────────────────────────────────────────────────────────
// Mutations — all return 302 redirects to the appropriate page
// ─────────────────────────────────────────────────────────────

// Each handler delegates the mutation to the shared client-admin module and maps
// the structured result onto a redirect. client_not_found → back to the list;
// every other outcome (success or a per-field rejection) → back to the detail
// page, matching the dashboard's prior redirect behaviour.

function toDetailOrList(tgUserId: number, clientMissing: boolean): Response {
  return clientMissing ? redirect("/admin/clients") : redirect(`/admin/clients/${tgUserId}`);
}

export async function handleUpdateClient(
  env: Env, req: Request, tgUserId: number,
): Promise<Response> {
  const form = await req.formData();
  const name = String(form.get("name") ?? "").trim();
  const active = form.get("active") === "on";
  const shadowMode = form.get("shadow_mode") === "on";
  const r = await updateClient(env, tgUserId, { name, active, shadowMode });
  return toDetailOrList(tgUserId, !r.ok);
}

export async function handleDeleteClient(env: Env, tgUserId: number): Promise<Response> {
  await removeClient(env, tgUserId);
  return redirect("/admin/clients");
}

export async function handleAddProject(
  env: Env, req: Request, tgUserId: number, deps: ClientsDeps = {},
): Promise<Response> {
  const form = await req.formData();
  const repo = String(form.get("repo") ?? "").trim();
  const explicitId = String(form.get("project_id") ?? "").trim();
  const nameHe = String(form.get("name_he") ?? "").trim();
  const semanticEnabled = form.get("semantic_enabled") !== null;
  const r = await addProject(env, tgUserId, {
    repo, projectId: explicitId || undefined, nameHe: nameHe || undefined, semanticEnabled,
  }, caDeps(deps));
  return toDetailOrList(tgUserId, !r.ok && r.reason === "client_not_found");
}

export async function handleSetProjectSemantic(
  env: Env, req: Request, tgUserId: number, projectId: string, deps: ClientsDeps = {},
): Promise<Response> {
  const form = await req.formData();
  const enabled = String(form.get("enabled") ?? "") === "on";
  const r = await setProjectSemantic(env, tgUserId, projectId, enabled, caDeps(deps));
  return toDetailOrList(tgUserId, !r.ok && r.reason === "client_not_found");
}

export async function handleUpdateProjectRepo(
  env: Env, req: Request, tgUserId: number, projectId: string,
  deps: ClientsDeps = {},
): Promise<Response> {
  const form = await req.formData();
  const newRepo = String(form.get("repo") ?? "").trim();
  const r = await setProjectRepo(env, tgUserId, projectId, newRepo, caDeps(deps));
  return toDetailOrList(tgUserId, !r.ok && r.reason === "client_not_found");
}

export async function handleDeleteProject(
  env: Env, tgUserId: number, projectId: string,
): Promise<Response> {
  const r = await removeProject(env, tgUserId, projectId, caDeps({}));
  return toDetailOrList(tgUserId, !r.ok && r.reason === "client_not_found");
}

export async function handleSetActiveProject(
  env: Env, req: Request, tgUserId: number,
): Promise<Response> {
  const form = await req.formData();
  const projectId = String(form.get("project_id") ?? "");
  const r = await setActiveProject(env, tgUserId, projectId);
  return toDetailOrList(tgUserId, !r.ok && r.reason === "client_not_found");
}

export async function handleSetDefaultProject(
  env: Env, req: Request, tgUserId: number,
): Promise<Response> {
  const form = await req.formData();
  const projectId = String(form.get("project_id") ?? "");
  const r = await setDefaultProject(env, tgUserId, projectId);
  return toDetailOrList(tgUserId, !r.ok && r.reason === "client_not_found");
}

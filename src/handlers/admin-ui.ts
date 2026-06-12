// Top-level dispatcher for /admin/*.
//
// Responsibilities:
//   - Route to login/callback/logout/static without authentication.
//   - For all other /admin/* routes, run requireAuth() and redirect to
//     /admin/login if unauthenticated.
//   - Catch unhandled errors and render a polite HTML error page.

import type { Env } from "../types";
import { TelegramClient } from "../lib/telegram";
import {
  requireAuth, startLogin, completeLogin, logout, redirect,
  type CurrentAdmin,
} from "../admin/auth";
import { htmlResponse } from "../admin/html";
import {
  renderErrorPage, renderSigninPage, renderCheckTelegramPage,
} from "../admin/layout";
import { handleStatic } from "../admin/static";
import {
  renderClientsList, handleNewClientGet, handleNewClientPost,
  renderClientDetail, handleUpdateClient, handleDeleteClient,
  handleAddProject, handleUpdateProjectRepo, handleDeleteProject,
  handleSetActiveProject, handleSetDefaultProject, handleSetProjectSemantic,
  type ClientsDeps,
} from "../admin/pages/clients";
import { continueIndexBuild } from "./index-step";
import { renderIssuesFeed, type IssuesDeps } from "../admin/pages/issues";
import { renderIndexStatusPage, handleRebuildIndex, type IndexStatusPageDeps } from "../admin/pages/index-status";
import { deleteIndexManifest, isKvQuotaError } from "../lib/kv";
import { renderAdminsList, handleAddAdmin, handleRemoveAdmin } from "../admin/pages/admins";

function htmlNotFound(currentAdmin: CurrentAdmin | null): Response {
  return htmlResponse(renderErrorPage({
    title: "Not found",
    message: "That page doesn't exist.",
    currentAdmin,
  }), { status: 404 });
}

async function handleLoginGet(url: URL): Promise<Response> {
  const reason = url.searchParams.get("reason");
  const flash =
    reason === "expired" ? { kind: "error" as const, message: "Your session expired. Sign in again." } :
    reason === "invalid" ? { kind: "error" as const, message: "Sign-in link expired or invalid." } :
    undefined;
  return htmlResponse(renderSigninPage({ flash }));
}

async function handleLoginPost(env: Env, req: Request, url: URL): Promise<Response> {
  const form = await req.formData();
  const raw = String(form.get("tg_user_id") ?? "").trim();
  const tgUserId = Number(raw);
  if (!Number.isFinite(tgUserId) || tgUserId <= 0) {
    return htmlResponse(renderSigninPage({
      flash: { kind: "error", message: "That doesn't look like a valid Telegram user ID." },
      prefilledTgUserId: raw,
    }), { status: 422 });
  }
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const baseUrl = `${url.protocol}//${url.host}`;
  // Silent for non-admins — same response either way. Errors in the DM are
  // swallowed so we never reveal whether an admin row exists.
  try {
    await startLogin(env, tg, tgUserId, baseUrl);
  } catch (e) {
    console.warn("admin_login_dm_failed", { error: (e as Error).message });
  }
  return htmlResponse(renderCheckTelegramPage());
}

async function handleCallback(env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("t") ?? "";
  const result = await completeLogin(env, token);
  if (!result.ok || !result.sessionCookie) {
    return redirect("/admin/login?reason=invalid");
  }
  return redirect("/admin", { "set-cookie": result.sessionCookie });
}

async function handleLogout(env: Env, req: Request): Promise<Response> {
  const clearHeader = await logout(env, req);
  return redirect("/admin/login", { "set-cookie": clearHeader });
}

export interface AdminUiDeps {
  clients?: ClientsDeps;
  issues?: IssuesDeps;
  indexStatus?: IndexStatusPageDeps;
}

export async function handleAdminUi(
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
  deps: AdminUiDeps = {},
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Proactive (best-effort) index build for repos attached/re-enabled via the
  // dashboard; cron + lazy ingest are the fallbacks. A test-injected kickoff in
  // deps.clients takes precedence.
  const clientsDeps: ClientsDeps = {
    ...deps.clients,
    kickoffIndexBuild: deps.clients?.kickoffIndexBuild ?? ((repo: string) => {
      if (ctx?.waitUntil) ctx.waitUntil(continueIndexBuild(req, env, repo, 0));
    }),
  };

  // Static assets — no auth, never error-rendered.
  if (path.startsWith("/admin/static/")) {
    const r = handleStatic(path);
    return r ?? new Response("not found", { status: 404 });
  }

  // Pre-auth routes.
  if (path === "/admin/login" && method === "GET")    return handleLoginGet(url);
  if (path === "/admin/login" && method === "POST")   return handleLoginPost(env, req, url);
  if (path === "/admin/callback" && method === "GET") return handleCallback(env, url);
  if (path === "/admin/logout" && method === "POST")  return handleLogout(env, req);

  // Authenticated routes.
  const currentAdmin = await requireAuth(env, req);
  if (!currentAdmin) {
    return redirect("/admin/login?reason=expired");
  }

  try {
    if (path === "/admin" || path === "/admin/" || path === "/admin/clients") {
      return await renderClientsList(env, currentAdmin);
    }
    if (path === "/admin/clients/new" && method === "GET")  return await handleNewClientGet(currentAdmin);
    if (path === "/admin/clients/new" && method === "POST") return await handleNewClientPost(env, req, currentAdmin, clientsDeps);

    // /admin/clients/:id
    const clientIdMatch = path.match(/^\/admin\/clients\/(\d+)$/);
    if (clientIdMatch) {
      const tgUserId = Number(clientIdMatch[1]);
      if (method === "GET") return await renderClientDetail(env, tgUserId, currentAdmin);
    }

    // /admin/clients/:id/update | /delete | /active-project | /default-project | /projects | /projects/:pid/repo | /projects/:pid/delete
    const updateMatch = path.match(/^\/admin\/clients\/(\d+)\/update$/);
    if (updateMatch && method === "POST") return await handleUpdateClient(env, req, Number(updateMatch[1]));

    const deleteMatch = path.match(/^\/admin\/clients\/(\d+)\/delete$/);
    if (deleteMatch && method === "POST") return await handleDeleteClient(env, Number(deleteMatch[1]));

    const activeMatch = path.match(/^\/admin\/clients\/(\d+)\/active-project$/);
    if (activeMatch && method === "POST") return await handleSetActiveProject(env, req, Number(activeMatch[1]));

    const defaultMatch = path.match(/^\/admin\/clients\/(\d+)\/default-project$/);
    if (defaultMatch && method === "POST") return await handleSetDefaultProject(env, req, Number(defaultMatch[1]));

    const addProjectMatch = path.match(/^\/admin\/clients\/(\d+)\/projects$/);
    if (addProjectMatch && method === "POST") return await handleAddProject(env, req, Number(addProjectMatch[1]), clientsDeps);

    const projectRepoMatch = path.match(/^\/admin\/clients\/(\d+)\/projects\/([^/]+)\/repo$/);
    if (projectRepoMatch && method === "POST") {
      return await handleUpdateProjectRepo(env, req, Number(projectRepoMatch[1]), projectRepoMatch[2]!, clientsDeps);
    }

    const projectSemanticMatch = path.match(/^\/admin\/clients\/(\d+)\/projects\/([^/]+)\/semantic$/);
    if (projectSemanticMatch && method === "POST") {
      return await handleSetProjectSemantic(env, req, Number(projectSemanticMatch[1]), projectSemanticMatch[2]!, clientsDeps);
    }

    const projectDeleteMatch = path.match(/^\/admin\/clients\/(\d+)\/projects\/([^/]+)\/delete$/);
    if (projectDeleteMatch && method === "POST") {
      return await handleDeleteProject(env, Number(projectDeleteMatch[1]), projectDeleteMatch[2]!);
    }

    if (path === "/admin/issues" && method === "GET") {
      const clientParam = url.searchParams.get("client");
      const clientTgUserId = clientParam ? Number(clientParam) : undefined;
      const filter = Number.isFinite(clientTgUserId) ? { clientTgUserId: clientTgUserId! } : {};
      return await renderIssuesFeed(env, currentAdmin, filter, deps.issues);
    }
    if (path === "/admin/index-status" && method === "GET") {
      return await renderIndexStatusPage(env, currentAdmin, deps.indexStatus);
    }
    if (path === "/admin/index/rebuild" && method === "POST") {
      return await handleRebuildIndex(env, req, {
        resetIndex: deleteIndexManifest,
        kickoffIndexBuild: clientsDeps.kickoffIndexBuild,
      });
    }

    if (path === "/admin/admins" && method === "GET")  return await renderAdminsList(env, currentAdmin);
    if (path === "/admin/admins" && method === "POST") return await handleAddAdmin(env, req);

    const adminDeleteMatch = path.match(/^\/admin\/admins\/(\d+)\/delete$/);
    if (adminDeleteMatch && method === "POST") {
      return await handleRemoveAdmin(env, Number(adminDeleteMatch[1]), currentAdmin);
    }

    return htmlNotFound(currentAdmin);
  } catch (e) {
    // Free-tier KV daily quota (e.g. CLIENTS.list() exceeding 1,000/day) is an
    // expected, self-healing condition — degrade to a clear banner instead of a
    // scary 500 + logged "incident". Resets at 00:00 UTC; removed by the paid plan.
    if (isKvQuotaError(e)) {
      console.warn("admin_ui_kv_quota", { path, method, error_message: (e as Error).message });
      return htmlResponse(renderErrorPage({
        title: "Daily storage limit reached",
        message: "The dashboard hit Cloudflare's free-tier KV usage limit for today. It resets automatically at 00:00 UTC. Upgrading the Worker to the paid plan removes this cap.",
        currentAdmin,
      }), { status: 503 });
    }
    const requestId = crypto.randomUUID();
    console.error("admin_ui_error", {
      request_id: requestId,
      path, method,
      error_message: (e as Error).message,
      stack: (e as Error).stack,
    });
    return htmlResponse(renderErrorPage({
      title: "Something went wrong",
      message: "An unexpected error occurred. The incident has been logged.",
      requestId,
      currentAdmin,
    }), { status: 500 });
  }
}

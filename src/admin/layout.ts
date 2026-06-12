// Page chrome shared across all /admin pages.

import { html, raw, type HtmlFragment } from "./html";
import { HTMX_URL, HTMX_INTEGRITY } from "./assets";
import type { CurrentAdmin } from "./auth";

export type NavKey = "clients" | "issues" | "admins" | "index";

interface PageOpts {
  title: string;
  nav: NavKey | null;
  body: HtmlFragment;
  currentAdmin: CurrentAdmin | null;
  flash?: { kind: "error" | "ok"; message: string };
  refreshSeconds?: number;
}

function header(currentAdmin: CurrentAdmin | null): HtmlFragment {
  return html`
    <div class="card-header">
      <div class="brand">
        <a href="/admin">workfluxs-feedback-bot</a><span class="sep">/</span>admin
      </div>
      <div class="user">
        ${currentAdmin
          ? html`<span>${currentAdmin.tg_user_id}</span>
                 <form method="post" action="/admin/logout" style="display:inline;">
                   <button class="btn btn-ghost btn-sm" type="submit">sign out</button>
                 </form>`
          : html``}
      </div>
    </div>
  `;
}

function nav(active: NavKey | null): HtmlFragment {
  if (active === null) return html``;
  const link = (key: NavKey, label: string, href: string) => html`
    <a class="${key === active ? "active" : ""}" href="${href}">${label}</a>
  `;
  return html`
    <div class="nav">
      ${link("clients", "clients", "/admin/clients")}
      ${link("issues", "issues", "/admin/issues")}
      ${link("index", "index", "/admin/index-status")}
      ${link("admins", "admins", "/admin/admins")}
    </div>
  `;
}

function flashFragment(flash: PageOpts["flash"]): HtmlFragment {
  if (!flash) return html``;
  const cls = flash.kind === "error" ? "flash flash-error" : "flash flash-ok";
  return html`<div id="flash" class="${cls}">${flash.message}</div>`;
}

export function renderPage(opts: PageOpts): HtmlFragment {
  return html`
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  ${opts.refreshSeconds ? raw(`<meta http-equiv="refresh" content="${opts.refreshSeconds}">`) : html``}
  <title>${opts.title} · workfluxs-feedback-bot</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="/admin/static/app.css">
  <script src="${raw(HTMX_URL)}" integrity="${raw(HTMX_INTEGRITY)}" crossorigin="anonymous" defer></script>
</head>
<body>
  <div class="shell">
    <div class="card">
      ${header(opts.currentAdmin)}
      ${nav(opts.nav)}
      <div class="card-body">
        ${flashFragment(opts.flash)}
        ${opts.body}
      </div>
    </div>
    <footer>workfluxs-feedback-bot · admin</footer>
  </div>
</body>
</html>`;
}

export function renderErrorPage(opts: {
  title: string;
  message: string;
  requestId?: string;
  currentAdmin: CurrentAdmin | null;
}): HtmlFragment {
  return renderPage({
    title: opts.title,
    nav: null,
    currentAdmin: opts.currentAdmin,
    body: html`
      <div class="center">
        <div class="col" style="text-align:center;">
          <h2 class="title">${opts.title}</h2>
          <p class="subtitle">${opts.message}</p>
          ${opts.requestId ? html`<p class="subtitle">request id: ${opts.requestId}</p>` : html``}
          <p><a class="link" href="/admin">back to dashboard</a></p>
        </div>
      </div>
    `,
  });
}

export function renderSigninPage(opts: {
  flash?: { kind: "error" | "ok"; message: string };
  prefilledTgUserId?: string;
}): HtmlFragment {
  return renderPage({
    title: "Sign in",
    nav: null,
    currentAdmin: null,
    body: html`
      <div class="center">
        <div class="signin-box card">
          <div class="card-body">
            <h2 class="title">Sign in</h2>
            <p class="subtitle">Enter your Telegram user ID. If you're an admin, you'll get a sign-in link via DM.</p>
            ${flashFragment(opts.flash)}
            <form method="post" action="/admin/login">
              <div class="field">
                <label for="tg_user_id">telegram user id</label>
                <input class="input" style="width:100%;" id="tg_user_id" name="tg_user_id" type="number" required value="${opts.prefilledTgUserId ?? ""}" autocomplete="off">
              </div>
              <button class="btn" type="submit" style="width:100%;">Send link</button>
            </form>
          </div>
        </div>
      </div>
    `,
  });
}

export function renderCheckTelegramPage(): HtmlFragment {
  return renderPage({
    title: "Check Telegram",
    nav: null,
    currentAdmin: null,
    body: html`
      <div class="center">
        <div class="signin-box card">
          <div class="card-body">
            <h2 class="title">Check your Telegram</h2>
            <p class="subtitle">If the ID you entered belongs to an admin, a sign-in link was just DMed to you. It expires in 10 minutes.</p>
            <p><a class="link" href="/admin/login">try a different ID</a></p>
          </div>
        </div>
      </div>
    `,
  });
}

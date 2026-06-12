// Embedded CSS for /admin/*. Loaded once via /admin/static/app.css.
// Color tokens copied from turbopuffer.com (dark theme) — see spec for
// rationale. Font is JetBrains Mono Variable, loaded from Google Fonts.

export const APP_CSS = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap');

* { box-sizing: border-box; }

:root {
  --background: hsl(222 47% 11%);
  --background-elev: hsl(222 47% 9%);
  --background-hover: hsl(240 4% 14%);
  --foreground: hsl(0 0% 100%);
  --muted: hsl(240 5% 65%);
  --border: hsl(240 4% 16%);
  --border-strong: hsl(240 4% 25%);
  --primary: hsl(0 0% 98%);
  --primary-foreground: hsl(240 6% 10%);
  --destructive: hsl(0 84% 60%);
  --ok: hsl(140 60% 65%);
  --warn: hsl(40 90% 70%);
  --radius: 0.5rem;
  --radius-sm: 0.375rem;
  --radius-xs: 0.25rem;
}

html, body {
  margin: 0;
  padding: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
}

a { color: var(--foreground); text-decoration: none; }
a:hover { text-decoration: underline; }

.shell { max-width: 1200px; margin: 0 auto; padding: 24px; }

.card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--background);
  margin-bottom: 24px;
}

.card-header {
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.card-body { padding: 18px; }

.brand { font-weight: 700; letter-spacing: -0.01em; }
.brand .sep { color: var(--muted); padding: 0 6px; }
.user { font-size: 11px; color: var(--muted); display: flex; gap: 12px; align-items: center; }
.user a { color: var(--muted); }
.user a:hover { color: var(--foreground); }

.nav { padding: 0 18px; border-bottom: 1px solid var(--border); display: flex; gap: 0; font-size: 12px; }
.nav a { padding: 10px 14px; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.nav a.active { color: var(--foreground); border-bottom-color: var(--foreground); font-weight: 700; }
.nav a:hover { color: var(--foreground); text-decoration: none; }

.title { font-size: 16px; font-weight: 700; margin: 0 0 2px 0; letter-spacing: -0.01em; }
.subtitle { font-size: 11px; color: var(--muted); margin: 0 0 16px 0; }

.toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 12px; flex-wrap: wrap; }

table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
th {
  font-weight: 700;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: var(--background-hover); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }

.btn {
  display: inline-block;
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  background: var(--primary);
  color: var(--primary-foreground);
  border: 1px solid var(--primary);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
}
.btn:hover { text-decoration: none; opacity: 0.9; }
.btn-ghost {
  background: transparent;
  color: var(--foreground);
  border-color: var(--border-strong);
}
.btn-danger {
  background: transparent;
  color: var(--destructive);
  border-color: var(--destructive);
}
.btn-danger:hover { background: var(--destructive); color: white; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-sm { padding: 3px 8px; font-size: 10px; }

.input, .select {
  padding: 6px 10px;
  background: var(--background-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--foreground);
  font: inherit;
  font-size: 11px;
}
.input:focus, .select:focus { outline: 2px solid var(--border-strong); outline-offset: -1px; }
.input.flex { flex: 1; }
label { display: block; font-size: 10px; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.06em; }

.field { margin-bottom: 12px; }
.field-error { font-size: 11px; color: var(--destructive); margin-top: 4px; }

.badge {
  display: inline-block;
  padding: 2px 7px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border);
  font-size: 10px;
  color: var(--muted);
}
.badge-ok { color: var(--ok); border-color: hsl(140 30% 25%); }
.badge-warn { color: var(--warn); border-color: hsl(40 30% 25%); }

.link {
  color: var(--foreground);
  text-decoration: none;
  border-bottom: 1px dashed var(--border-strong);
}
.link:hover { border-bottom-style: solid; text-decoration: none; }
.link-muted { color: var(--muted); }

.flash {
  padding: 10px 14px;
  margin-bottom: 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--background-elev);
  font-size: 12px;
}
.flash-error { border-color: var(--destructive); color: var(--destructive); }
.flash-ok { border-color: hsl(140 30% 25%); color: var(--ok); }

.form-row { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; }
.form-row .field { margin-bottom: 0; flex: 1; min-width: 140px; }

.empty {
  padding: 32px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}

.actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

.kv { display: grid; grid-template-columns: 140px 1fr; gap: 8px 16px; font-size: 12px; }
.kv dt { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; align-self: center; }
.kv dd { margin: 0; }

.center { display: flex; align-items: center; justify-content: center; min-height: 60vh; }
.col { display: flex; flex-direction: column; gap: 8px; }

.signin-box { width: 100%; max-width: 360px; }
.signin-box .card-body { padding: 24px; }

@media (max-width: 720px) {
  .shell { padding: 12px; }
  .card-header { flex-direction: column; align-items: flex-start; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .hide-sm { display: none; }
}

footer { text-align: center; color: var(--muted); font-size: 11px; padding: 24px 0; }
`.trim();

// htmx loaded from unpkg with SRI integrity check. Stable version pinned.
// SRI value was computed locally:
//   curl -sL https://unpkg.com/htmx.org@2.0.7/dist/htmx.min.js | openssl dgst -sha384 -binary | openssl base64 -A
export const HTMX_VERSION = "2.0.7";
export const HTMX_URL = `https://unpkg.com/htmx.org@${HTMX_VERSION}/dist/htmx.min.js`;
export const HTMX_INTEGRITY = "sha384-ZBXiYtYQ6hJ2Y0ZNoYuI+Nq5MqWBr+chMrS/RkXpNzQCApHEhOt2aY8EJgqwHLkJ";

// Tagged-template HTML helper with automatic escaping.
//
// Usage:
//   html`<p>${userInput}</p>`        // userInput escaped
//   html`<div>${html`<p>X</p>`}</div>`  // nested fragments NOT re-escaped
//   html`<ul>${rows.map(r => html`<li>${r}</li>`)}</ul>`  // arrays flattened
//
// Renders to a string via renderHtml(). Fragments compose without losing
// their "trusted" status, so we can build pages from helper functions.

const RAW = Symbol("html.raw");

export interface HtmlFragment {
  readonly [RAW]: true;
  readonly value: string;
}

function isFragment(v: unknown): v is HtmlFragment {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[RAW] === true;
}

export function raw(value: string): HtmlFragment {
  return { [RAW]: true, value };
}

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]!);
}

function format(value: unknown): string {
  if (value == null || value === false) return "";
  if (isFragment(value)) return value.value;
  if (Array.isArray(value)) return value.map(format).join("");
  return escape(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): HtmlFragment {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += format(values[i]) + (strings[i + 1] ?? "");
  }
  return raw(out);
}

export function renderHtml(fragment: HtmlFragment): string {
  return fragment.value;
}

export function htmlResponse(fragment: HtmlFragment, init: ResponseInit = {}): Response {
  return new Response(`<!DOCTYPE html>\n${fragment.value}`, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

export function htmlFragmentResponse(fragment: HtmlFragment, init: ResponseInit = {}): Response {
  return new Response(fragment.value, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

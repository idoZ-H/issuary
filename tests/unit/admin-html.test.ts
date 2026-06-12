import { describe, it, expect } from "vitest";
import { html, raw, renderHtml } from "../../src/admin/html";

describe("html tagged template", () => {
  it("escapes interpolated strings", () => {
    const dangerous = '<script>alert("xss")</script>';
    const out = renderHtml(html`<p>${dangerous}</p>`);
    expect(out).toBe("<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>");
  });

  it("escapes single quotes and ampersands", () => {
    const out = renderHtml(html`<span>${"a & b's"}</span>`);
    expect(out).toBe("<span>a &amp; b&#39;s</span>");
  });

  it("does not re-escape nested fragments", () => {
    const inner = html`<em>${"<bold>"}</em>`;
    const out = renderHtml(html`<p>${inner}</p>`);
    expect(out).toBe("<p><em>&lt;bold&gt;</em></p>");
  });

  it("flattens arrays of fragments and strings", () => {
    const rows = ["a", "<b>", html`<i>raw</i>`];
    const out = renderHtml(html`<ul>${rows.map((r) => html`<li>${r}</li>`)}</ul>`);
    expect(out).toBe("<ul><li>a</li><li>&lt;b&gt;</li><li><i>raw</i></li></ul>");
  });

  it("renders null and false as empty", () => {
    const out = renderHtml(html`<p>${null}${false}${undefined}x</p>`);
    expect(out).toBe("<p>x</p>");
  });

  it("raw() bypasses escaping", () => {
    const out = renderHtml(html`<p>${raw("<b>trusted</b>")}</p>`);
    expect(out).toBe("<p><b>trusted</b></p>");
  });

  it("coerces numbers and booleans correctly", () => {
    expect(renderHtml(html`<p>${42}</p>`)).toBe("<p>42</p>");
    expect(renderHtml(html`<p>${true}</p>`)).toBe("<p>true</p>");
  });
});

import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "../../src/lib/github";

const baseRes = (json: unknown, status = 200) =>
  new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

describe("GitHubClient", () => {
  it("searches code", async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/search/code?q=");
      return baseRes({ items: [{ path: "src/x.tsx", html_url: "https://github.com/x/y/blob/x.tsx", text_matches: [{ fragment: "snip" }] }] });
    });
    const gh = new GitHubClient("PAT", fakeFetch as unknown as typeof fetch);
    const r = await gh.searchCode("x/y", "export");
    expect(r.matches[0]?.path).toBe("src/x.tsx");
  });

  it("searches issues with state filter", async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("state%3Aopen");
      return baseRes({ items: [{ number: 42, title: "Bug", state: "open", labels: [{ name: "bug" }], updated_at: "2026-04-29T00:00:00Z", html_url: "u" }] });
    });
    const gh = new GitHubClient("PAT", fakeFetch as unknown as typeof fetch);
    const r = await gh.searchIssues("x/y", "export", "open");
    expect(r.matches[0]).toMatchObject({ number: 42, state: "open" });
  });

  it("reads a file (decoded from base64)", async () => {
    const content = btoa("hello world");
    const fakeFetch = vi.fn(async () => baseRes({ content, encoding: "base64", size: 11 }));
    const gh = new GitHubClient("PAT", fakeFetch as unknown as typeof fetch);
    const r = await gh.readFile("x/y", "README.md");
    expect(r.content).toBe("hello world");
    expect(r.size_bytes).toBe(11);
  });

  it("creates an issue", async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/repos/x/y/issues");
      const body = JSON.parse(String(init?.body));
      expect(body.title).toBe("T");
      return new Response(JSON.stringify({ number: 7, html_url: "u" }), { status: 201 });
    });
    const gh = new GitHubClient("PAT", fakeFetch as unknown as typeof fetch);
    const r = await gh.createIssue("x/y", { title: "T", body: "B", labels: ["a"] });
    expect(r.number).toBe(7);
  });

  it("retries 5xx then succeeds", async () => {
    let count = 0;
    const fakeFetch = vi.fn(async () => {
      count++;
      if (count < 3) return new Response("oops", { status: 503 });
      return new Response(JSON.stringify({ number: 1, html_url: "u" }), { status: 201 });
    });
    const gh = new GitHubClient("PAT", fakeFetch as unknown as typeof fetch, { retryDelayMs: 0 });
    const r = await gh.createIssue("x/y", { title: "T", body: "B", labels: [] });
    expect(r.number).toBe(1);
    expect(count).toBe(3);
  });

  it("getRepoTree returns full recursive file paths via git trees API", async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repos/x/y")) {
        return baseRes({ default_branch: "main" });
      }
      if (url.includes("/git/trees/main?recursive=1")) {
        return baseRes({
          tree: [
            { path: "package.json", type: "blob" },
            { path: "src", type: "tree" },
            { path: "src/components/Header.tsx", type: "blob" },
            { path: "src/pages/index.tsx", type: "blob" },
            { path: "node_modules/foo/index.js", type: "blob" },
            { path: "package-lock.json", type: "blob" },
          ],
        });
      }
      return new Response("", { status: 404 });
    });
    const gh = new GitHubClient("PAT", fakeFetch as unknown as typeof fetch);
    const tree = await gh.getRepoTree("x/y");
    expect(tree).toContain("src/components/Header.tsx");
    expect(tree).toContain("src/pages/index.tsx");
    expect(tree).not.toContain("src");
    expect(tree.find((p) => p.startsWith("node_modules/"))).toBeUndefined();
    expect(tree.find((p) => p === "package-lock.json")).toBeUndefined();
  });

  it("getRepoTree falls back to top-level contents when git trees API fails", async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repos/x/y")) return new Response("err", { status: 500 });
      if (url.endsWith("/repos/x/y/contents/")) {
        return baseRes([{ type: "dir", path: "src" }, { type: "file", path: "README.md" }]);
      }
      return new Response("", { status: 404 });
    });
    const gh = new GitHubClient("PAT", fakeFetch as unknown as typeof fetch, { retryDelayMs: 0 });
    const tree = await gh.getRepoTree("x/y");
    expect(tree).toEqual(["dir src", "file README.md"]);
  });
});

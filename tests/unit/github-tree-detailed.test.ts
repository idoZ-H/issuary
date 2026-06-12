import { describe, it, expect } from "vitest";
import { GitHubClient } from "../../src/lib/github";

function ghWith(treeJson: any): GitHubClient {
  const fetcher = (async (url: string) => {
    if (String(url).includes("/git/trees/")) return new Response(JSON.stringify(treeJson));
    if (String(url).endsWith("/repos/o/r")) return new Response(JSON.stringify({ default_branch: "main" }));
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  return new GitHubClient("tok", fetcher);
}

describe("getRepoTreeDetailed", () => {
  it("returns path+sha for blobs, filtering non-blobs", async () => {
    const gh = ghWith({ tree: [
      { path: "src/a.ts", type: "blob", sha: "aaa" },
      { path: "src", type: "tree", sha: "ttt" },
      { path: "src/b.ts", type: "blob", sha: "bbb" },
    ] });
    const out = await gh.getRepoTreeDetailed("o/r");
    expect(out).toEqual([{ path: "src/a.ts", sha: "aaa" }, { path: "src/b.ts", sha: "bbb" }]);
    expect(await gh.getRepoTree("o/r")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("filters noise paths and honors the maxFiles cap", async () => {
    const gh = ghWith({ tree: [
      { path: "src/a.ts", type: "blob", sha: "a" },
      { path: "node_modules/x.js", type: "blob", sha: "n" }, // noise → dropped
      { path: "src/b.ts", type: "blob", sha: "b" },
      { path: "src/c.ts", type: "blob", sha: "c" },
    ] });
    const out = await gh.getRepoTreeDetailed("o/r", { maxFiles: 2 });
    expect(out).toEqual([{ path: "src/a.ts", sha: "a" }, { path: "src/b.ts", sha: "b" }]);
  });

  it("THROWS on tree failure (no destructive empty-tree); only getRepoTree degrades to contents", async () => {
    const fetcher = (async (url: string) => {
      if (String(url).includes("/git/trees/")) return new Response("boom", { status: 500 });
      if (String(url).endsWith("/repos/o/r")) return new Response(JSON.stringify({ default_branch: "main" }));
      if (String(url).endsWith("/contents/")) {
        return new Response(JSON.stringify([{ type: "file", path: "README" }, { type: "dir", path: "src" }]));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as any;
    const gh = new GitHubClient("tok", fetcher, { retryDelayMs: 0 }); // skip backoff on the forced 500
    // getRepoTreeDetailed must reject — sha-diff callers must never see a fake empty tree.
    await expect(gh.getRepoTreeDetailed("o/r")).rejects.toThrow();
    // getRepoTree still degrades to the prefixed contents listing for the classifier.
    expect(await gh.getRepoTree("o/r")).toEqual(["file README", "dir src"]);
  });
});

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { fetchCodebaseContext } from "../../src/pipeline/codebase-context";
import { putRepoContext, getRepoContext } from "../../src/lib/kv";

describe("fetchCodebaseContext", () => {
  it("returns cached context when present", async () => {
    await putRepoContext(env as any, "x/y", {
      tree: "src/", readme: "README", recent_issues: [],
      fetched_at: new Date().toISOString(),
    });
    const gh = { getRepoTree: vi.fn(), getReadme: vi.fn(), listRecentIssues: vi.fn() };
    const ctx = await fetchCodebaseContext(env as any, "x/y", gh as any);
    expect(ctx.readme).toBe("README");
    expect(gh.getRepoTree).not.toHaveBeenCalled();
  });

  it("fetches and caches when miss", async () => {
    const gh = {
      getRepoTree: vi.fn(async () => ["dir src", "file README.md"]),
      getReadme: vi.fn(async () => "Hello world"),
      listRecentIssues: vi.fn(async () => [{ number: 1, title: "T", labels: [], state: "open" as const }]),
    };
    const ctx = await fetchCodebaseContext(env as any, "fresh/repo", gh as any);
    expect(ctx.tree).toContain("src");
    expect(ctx.readme).toBe("Hello world");
    expect(ctx.recent_issues[0]?.title).toBe("T");
    const cached = await getRepoContext(env as any, "fresh/repo");
    expect(cached?.readme).toBe("Hello world");
  });
});

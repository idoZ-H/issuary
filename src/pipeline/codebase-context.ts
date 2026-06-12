import type { Env, RepoContext } from "../types";
import { getRepoContext, putRepoContext } from "../lib/kv";
import type { GitHubClient } from "../lib/github";

// Cache TTL is enforced by KV (REPO_CONTEXT_TTL_S = 6h in lib/kv.ts). When
// the cache misses we fan out three GitHub calls in parallel — combined budget
// is roughly one round-trip's worth of latency on a warm classifier path.
export async function fetchCodebaseContext(env: Env, repo: string, gh: GitHubClient): Promise<RepoContext> {
  const cached = await getRepoContext(env, repo);
  if (cached) return cached;

  const [tree, readme, recent_issues] = await Promise.all([
    gh.getRepoTree(repo),
    gh.getReadme(repo),
    gh.listRecentIssues(repo),
  ]);

  const ctx: RepoContext = {
    tree: tree.join("\n"),
    readme,
    recent_issues,
    fetched_at: new Date().toISOString(),
  };
  await putRepoContext(env, repo, ctx);
  return ctx;
}

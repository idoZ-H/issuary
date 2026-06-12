import type { Env } from "../types";
import { GitHubClient } from "../lib/github";
import { ensureFreshIndex, type EnsureIndexResult } from "../pipeline/code-index";

const MAX_HOPS = 40; // safety backstop; the build terminates naturally (cursor advances each slice).
export const INDEX_STEP_PATH = "/internal/index-step";

// Injectable seams for testing (real impls used in production).
export interface IndexStepDeps {
  buildGh?: (env: Env, repo: string) => Promise<GitHubClient>;
  ensureFreshIndexFn?: (env: Env, repo: string, gh: GitHubClient) => Promise<EnsureIndexResult>;
  fetcher?: typeof fetch;
}

// Self-continuing index build endpoint. Indexes ONE slice, then — if the repo
// isn't fully indexed — fires a request to itself (fresh invocation, fresh
// subrequest budget) for the next slice. Authenticated by the Worker's own
// webhook secret so it cannot be driven externally.
export async function handleIndexStep(req: Request, env: Env, _ctx: ExecutionContext, deps: IndexStepDeps = {}): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || req.headers.get("X-Internal-Secret") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { repo?: string; hop?: number } | null;
  const repo = body?.repo;
  const hop = typeof body?.hop === "number" ? body.hop : 0;
  if (!repo) return Response.json({ error: "missing repo" }, { status: 400 });

  const buildGh = deps.buildGh ?? ((e: Env, r: string) => GitHubClient.forRepo(e, r));
  const ensureFn = deps.ensureFreshIndexFn ?? ((e: Env, r: string, gh: GitHubClient) => ensureFreshIndex(e, r, gh));

  let result: EnsureIndexResult;
  try {
    const gh = await buildGh(env, repo);
    result = await ensureFn(env, repo, gh);
  } catch (e) {
    console.warn("code_index_build_failed", { repo, hop, error: (e as Error).message });
    return Response.json({ repo, error: "build_failed" }); // 200: best-effort, next message resumes
  }

  console.log("code_index_build_progress", {
    repo, hop, indexed: result.indexed_files, total: result.total_files,
    complete: result.complete, chunks: result.chunk_count,
  });

  // Await the next hop INLINE (not ctx.waitUntil): each hop holds its response
  // until its whole downstream chain finishes, so the entire chain stays alive
  // under the original triggering request's single waitUntil. A child
  // ctx.waitUntil here would be cancelled when this invocation completes.
  if (result.built && !result.complete && hop + 1 < MAX_HOPS) {
    await continueIndexBuild(req, env, repo, hop + 1, deps.fetcher);
  }
  return Response.json({ repo, indexed: result.indexed_files, total: result.total_files, complete: result.complete });
}

// Fire a self-request to run the next slice. Best-effort; errors are swallowed
// (the next triggering message resumes from the persisted cursor anyway).
export async function continueIndexBuild(req: Request, env: Env, repo: string, hop: number, fetcher: typeof fetch = fetch): Promise<void> {
  const url = new URL(INDEX_STEP_PATH, req.url).toString();
  try {
    await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Internal-Secret": env.TELEGRAM_WEBHOOK_SECRET ?? "" },
      body: JSON.stringify({ repo, hop }),
    });
  } catch (e) {
    // best-effort: a dropped hop is resumed on the next triggering message
    console.warn("code_index_continue_failed", { repo, hop, error: (e as Error).message });
  }
}

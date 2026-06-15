import type { Env } from "../types";
import { GitHubClient, verifyGitHubSignature } from "../lib/github";
import { TelegramClient } from "../lib/telegram";
import { ClaudeClient } from "../lib/ai";
import { getClient, getIssueChat, listClients, canonicalizeRepo } from "../lib/kv";
import { draftClosureMessage } from "../pipeline/closure";
import { notifyIdo } from "../pipeline/notifier";
import { applyIncremental, isExcludedFromCodeIndex } from "../pipeline/code-index";
import { continueIndexBuild } from "./index-step";

// Above this many changed files in one push, skip the precise inline update and
// let the (equally cheap) blob-SHA diff reconcile the whole repo instead — keeps
// a single invocation under the subrequest cap.
const PUSH_INLINE_MAX_FILES = 30;

export interface GitHubHandlerDeps {
  tgFactory?: (env: Env) => TelegramClient;
  draftClosure?: typeof draftClosureMessage;
  // Push-path seams (injected in tests; real impls in production).
  listClientsFn?: typeof listClients;
  buildGh?: (env: Env, repo: string) => Promise<GitHubClient>;
  applyIncrementalFn?: typeof applyIncremental;
  continueIndexBuildFn?: typeof continueIndexBuild;
}

// Pure: collapse a push payload's per-commit added/modified/removed into a single
// changed/removed set for the whole push. A path that appears in both modified
// and removed is treated as removed (its net state at HEAD). `truncated` flags
// GitHub capping `commits` at 20 — we then can't trust the list and fall back to
// the blob-SHA diff.
export function filesFromPush(payload: any): { changed: string[]; removed: string[]; ref: string; truncated: boolean } {
  const commits: any[] = payload.commits ?? [];
  const changed = new Set<string>();
  const removed = new Set<string>();
  for (const c of commits) {
    for (const f of c.added ?? []) changed.add(f);
    for (const f of c.modified ?? []) changed.add(f);
    for (const f of c.removed ?? []) removed.add(f);
  }
  for (const f of removed) changed.delete(f);
  return { changed: [...changed], removed: [...removed], ref: payload.ref, truncated: commits.length >= 20 };
}

async function handlePush(req: Request, env: Env, ctx: ExecutionContext | undefined, payload: any, deps: GitHubHandlerDeps): Promise<Response> {
  // GitHub sends the repo's actual display case in full_name; canonicalize so it
  // matches the canonical p.repo and keys the same manifest as every other path.
  const fullName: string | undefined = payload.repository?.full_name;
  const repo: string | undefined = fullName ? canonicalizeRepo(fullName) : undefined;
  const defaultBranch: string | undefined = payload.repository?.default_branch;
  // Default branch only; ignore tags, feature branches, and branch deletes.
  if (!repo || payload.deleted || payload.ref !== `refs/heads/${defaultBranch}`) {
    return Response.json({ action: "ignored", reason: "non-default-branch or branch delete" });
  }

  // Only act if some semantic-enabled project maps to this repo.
  const clients = await (deps.listClientsFn ?? listClients)(env);
  const hasSemanticProject = clients.some(({ record }) =>
    record.projects.some((p) => p.repo === repo && p.semantic_enabled !== false)
  );
  if (!hasSemanticProject) return Response.json({ action: "ignored", reason: "no semantic project for repo" });

  const { changed, removed, truncated } = filesFromPush(payload);
  const changedFiltered = changed.filter((p) => !isExcludedFromCodeIndex(p));

  const applyFn = deps.applyIncrementalFn ?? applyIncremental;
  const continueFn = deps.continueIndexBuildFn ?? continueIndexBuild;
  const buildGh = deps.buildGh ?? ((e: Env, r: string) => GitHubClient.forRepo(e, r));

  // A truncated/forced push (unreliable file lists) or a very large change set
  // falls back to the blob-SHA diff, which reconciles the whole repo cheaply.
  // Otherwise apply the precise inline update.
  const useDiffFallback = truncated || !!payload.forced || changedFiltered.length > PUSH_INLINE_MAX_FILES;
  const run = async () => {
    try {
      if (useDiffFallback) {
        await continueFn(req, env, repo, 0);
      } else if (changedFiltered.length > 0 || removed.length > 0) {
        const gh = await buildGh(env, repo);
        await applyFn(env, repo, gh, changedFiltered, removed, { headSha: payload.after });
      }
    } catch (e) {
      console.warn("github_push_index_failed", { repo, error: (e as Error).message });
    }
  };
  // Return 200 immediately; do the indexing after the response (push retries on
  // timeout — same retry-storm class as the Telegram incident in CLAUDE.md).
  if (ctx?.waitUntil) ctx.waitUntil(run());
  else await run();

  return Response.json({
    action: useDiffFallback ? "indexing_diff" : "indexing",
    repo,
    changed: changedFiltered.length,
    removed: removed.length,
  });
}

async function handleGitHubWebhookImpl(req: Request, env: Env, ctx: ExecutionContext | undefined, deps: GitHubHandlerDeps): Promise<Response> {
  const raw = await req.text();
  const sigHeader = req.headers.get("X-Hub-Signature-256");
  if (!(await verifyGitHubSignature(raw, sigHeader, env.GITHUB_WEBHOOK_SECRET))) {
    return new Response("unauthorized", { status: 401 });
  }
  const event = req.headers.get("X-GitHub-Event");
  if (event === "push") return await handlePush(req, env, ctx, JSON.parse(raw), deps);
  if (event !== "issues") return Response.json({ action: "ignored", reason: "non-issues event" });
  const payload = JSON.parse(raw);
  if (payload.action !== "closed") return Response.json({ action: "ignored", reason: "non-close action" });

  const repo: string = canonicalizeRepo(payload.repository.full_name);
  const number: number = payload.issue.number;
  const ic = await getIssueChat(env, repo, number);
  if (!ic) return Response.json({ action: "ignored", reason: "no chat mapping" });

  const tg = deps.tgFactory ? deps.tgFactory(env) : new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const claude = ClaudeClient.fromApiKey(env.ANTHROPIC_API_KEY);
  const drafter = deps.draftClosure ?? draftClosureMessage;
  const draftedMessage = await drafter(claude, {
    title: payload.issue.title,
    closing_comment: payload.comment?.body ?? "",
  });

  // Multi-project clients see "→ <name_he>" before the closure message.
  const client = await getClient(env, ic.tg_user_id);
  const project = client?.projects.find((p) => p.repo === repo);
  const message = client && client.projects.length > 1 && project
    ? `→ ${project.name_he}\n─────\n${draftedMessage}`
    : draftedMessage;

  // The closure DM is the client's only signal their issue was resolved, and
  // the outer handler swallows errors into a 200 — so a failed send would be
  // invisible. Surface it to Ido's inbox instead of letting it vanish.
  try {
    await tg.sendMessage(ic.telegram_chat_id, message);
  } catch (e) {
    await notifyIdo(tg, Number(env.IDO_INBOX_CHAT_ID), {
      action: "error",
      reporter_name: client?.name ?? String(ic.tg_user_id),
      repo,
      message: `Closure DM failed to send for #${number}: ${(e as Error).message}`,
    });
    return Response.json({ action: "closure_dm_failed", number });
  }
  return Response.json({ action: "notified", number });
}

export async function handleGitHubWebhook(req: Request, env: Env, ctx: ExecutionContext | undefined, deps: GitHubHandlerDeps = {}): Promise<Response> {
  try {
    return await handleGitHubWebhookImpl(req, env, ctx, deps);
  } catch (e) {
    console.error("github_handler_error", {
      error_message: (e as Error).message,
      stack: (e as Error).stack,
    });
    return new Response("ok", { status: 200 });
  }
}

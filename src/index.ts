import type { Env } from "./types";
import { handleTelegramWebhook } from "./handlers/telegram";
import { handleGitHubWebhook } from "./handlers/github";
import { handleAdminUi } from "./handlers/admin-ui";
import { handleIndexStep, INDEX_STEP_PATH } from "./handlers/index-step";
import { getLangSmithClient } from "./lib/ai";
import { TelegramClient, safeSend } from "./lib/telegram";
import { runIndexMaintenance } from "./pipeline/index-maintenance";

function bridgeEnv(env: Env): void {
  const proc = (globalThis as any).process ?? ((globalThis as any).process = {});
  const e = proc.env ?? (proc.env = {});
  if (env.LANGSMITH_API_KEY && !e.LANGSMITH_API_KEY) {
    e.LANGSMITH_TRACING = env.LANGSMITH_TRACING ?? "true";
    e.LANGSMITH_API_KEY = env.LANGSMITH_API_KEY;
    e.LANGSMITH_ENDPOINT = env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com";
    e.LANGSMITH_PROJECT = env.LANGSMITH_PROJECT ?? "feedback-bot";
    e.LANGSMITH_TRACING_BACKGROUND = env.LANGSMITH_TRACING_BACKGROUND ?? "false";
  }
}

function flushTraces(ctx: ExecutionContext): void {
  const ls = getLangSmithClient();
  if (ls) {
    ctx.waitUntil(ls.awaitPendingTraceBatches().catch(() => undefined));
  }
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/" && req.method === "GET") {
    return Response.json({ ok: true, service: "workfluxs-feedback-bot", version: "1.0" });
  }
  if (url.pathname === "/telegram/webhook") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    return await handleTelegramWebhook(req, env, {}, ctx);
  }
  if (url.pathname === "/github/webhook") {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    return await handleGitHubWebhook(req, env, ctx, {});
  }
  if (url.pathname === INDEX_STEP_PATH) {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    return await handleIndexStep(req, env, ctx);
  }
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return await handleAdminUi(req, env, ctx);
  }
  return new Response("not found", { status: 404 });
}

// Best-effort apology to the client when the worker bails. We re-parse the
// body because we don't have access to parsed update by the time we catch.
async function bestEffortClientApology(req: Request, env: Env): Promise<void> {
  if (!new URL(req.url).pathname.startsWith("/telegram/webhook")) return;
  try {
    const cloned = req.clone();
    const update = await cloned.json<any>();
    const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
    if (typeof chatId !== "number" || !env.TELEGRAM_BOT_TOKEN) return;
    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    await safeSend(tg, chatId, "מצטער, משהו השתבש בעיבוד ההודעה. אידו יבדוק. נסה/י שוב בעוד דקה 🙏", "uncaught_apology");
  } catch {
    // Best-effort. If even the apology fails, swallow.
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    bridgeEnv(env);
    try {
      return await route(req, env, ctx);
    } catch (e) {
      console.error("worker_error", {
        url: req.url,
        method: req.method,
        error_message: (e as Error).message,
        stack: (e as Error).stack,
      });
      const path = new URL(req.url).pathname;
      // Admin UI requests want a real HTML error page, not a swallowed 200.
      // Its handler has its own try/catch, so reaching this outer catch means
      // something pretty fundamental broke — surface a 500.
      if (path === "/admin" || path.startsWith("/admin/")) {
        return new Response("admin error — check worker logs", { status: 500 });
      }
      await bestEffortClientApology(req, env);
      return new Response("ok", { status: 200 });
    } finally {
      flushTraces(ctx);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    bridgeEnv(env);
    ctx.waitUntil(runIndexMaintenance(env));
  },
} satisfies ExportedHandler<Env>;

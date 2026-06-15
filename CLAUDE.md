# CLAUDE.md — issuary

Cloudflare Worker that turns client Telegram messages into structured GitHub Issues via Claude (Opus 4.8 classifier, Sonnet 4.6 closure-DM) with tool use, GitHub App auth, GCS media storage, Gemini voice transcription, and LangSmith tracing. Multi-project per client; Hebrew client replies, English issue bodies (for downstream code-agent compatibility).

Operational docs live in `docs/operations.md`. (Internal design specs/plans are kept out of the public repo.)

---

## ⚠️ Context budget — the `claude-api` skill

The `claude-api` skill loads its *entire* bundle (~404 KB / **~152K tokens**) on a single invocation, jumping a fresh session from ~38K to ~190K. Because this is a Claude-classifier codebase (`src/lib/ai.ts`, the prompt notes, commits all name *Claude / Opus / Sonnet*), its "load whenever Claude is named" trigger fired on nearly every task — the diagnosed cause of "context jumps to 200K after the first message."

It's now set to `"user-invocable-only"` in `~/.claude/settings.json` (`skillOverrides`), so it no longer auto-triggers — only an explicit `/claude-api` loads it. For the Claude-API questions that actually come up here (model ids, `effort`, `max_tokens`, caching, triage-prompt tuning), read `src/lib/ai.ts` + the "Classifier prompt + Opus 4.8 behavior" section below first. Be wary of invoking any large-bundle skill mid-task; prefer `Read`-ing the one file you need.

---

## High-leverage gotchas (read these before touching the code)

### Cloudflare Workers + the test harness

**`nodejs_compat` is a half-truth in vitest-pool-workers.** Production Workers (with `compatibility_flags = ["nodejs_compat"]`) load `node:fs/promises`, `node:crypto`, etc. fine. The workerd build inside `@cloudflare/vitest-pool-workers` does NOT — it errors with `No such module "node:fs/promises"`. Anything that transitively imports those modules must be aliased to a local stub in `vitest.config.ts` for tests. We do this for `langsmith`, `langsmith/wrappers/anthropic`, and `langsmith/traceable` — see `tests/stubs/langsmith*.ts`. Production uses langsmith's `browser` build (resolved via `package.json` exports). The aliases are test-only.

**Don't store `fetch` directly on `this`.** Storing the global `fetch` as a class member (`this.fetcher = fetch`) and calling `this.fetcher(url)` throws `Illegal invocation: function called with incorrect 'this' reference`. Workers' `fetch` enforces a specific `this` binding. Always wrap:

```typescript
constructor(..., fetcher: FetchLike = fetch) {
  this.fetcher = (input, init) => fetcher(input, init);  // detaches `this`
}
```

This bit `TelegramClient`, `GitHubClient`, and `GcsClient` simultaneously.

**Worker secrets aren't on `process.env`.** They're on the `env` binding to `fetch()`. Libraries that read env Node-style (`langsmith` in particular) need an explicit bridge — see `bridgeEnv()` in `src/index.ts`. The bridge runs at the top of every fetch handler.

**Module-load order vs. `process.env`.** `bridgeEnv()` runs IN the fetch handler — but `import` statements are evaluated at module load, before any handler runs. If a library reads `process.env` at module load (e.g. constructs a default singleton client there), it gets the un-bridged version. Workaround: instantiate things lazily on first use, after the bridge has run. This is why `getLangSmithClient()` is a lazy factory and `runClassifier` re-wraps `traceable` on first call.

**`ctx.waitUntil()` is mandatory for any async work that outlives the response.** The Worker isolate is reaped the moment `fetch()` returns its `Response`. Pending HTTP requests (LangSmith trace POSTs, fire-and-forget logging, etc.) get cancelled mid-flight. Wrap them in `ctx.waitUntil(promise)` to keep the isolate alive past the response. We use this for `client.awaitPendingTraceBatches()` in `flushTraces()`.

### LangSmith specifics

- We use an **explicit `Client` instance** (lazy, in `src/lib/ai.ts::getLangSmithClient`) instead of langsmith's default singleton. The default singleton's queue is unreachable from outside; an explicit client lets us call `awaitPendingTraceBatches()` from `ctx.waitUntil()`.
- `wrapAnthropic(rawSdk, { client })` and `traceable(fn, { client })` both accept the explicit client via options.
- **Always set `processInputs` on `traceable`** when the wrapped function takes complex objects. We learned the hard way that the Anthropic SDK instance and `GitHubClient` carry their tokens (`apiKey`, installation token) on internal fields — and `traceable` walks the entire input graph, so those secrets ended up in LangSmith's run inputs in plaintext. The current scrubber in `src/pipeline/classifier.ts` keeps only `userText` plus shape metadata.
- LangSmith deletes are not supported via the public API (HTTP 405). Delete leaked traces via the LangSmith UI manually.
- Project: `feedback-bot` (UUID `<your-langsmith-project-uuid>`).

### GitHub App auth

- **PEM keys from GitHub are PKCS#1**, but Web Crypto's `importKey("pkcs8", ...)` only accepts PKCS#8. We have an ASN.1 wrapper (`pkcs1ToPkcs8`) in `src/lib/github.ts` that prefixes the right `PrivateKeyInfo` envelope. Don't try to feed PKCS#1 directly.
- **GitHub API rejects requests without a `User-Agent` header** with a confusing 403 ("Request forbidden by administrative rules"). Workers' `fetch` doesn't set one by default. We always send `User-Agent: issuary` on both `getInstallationToken` and `GitHubClient.request`.
- **GitHub code search is unreliable on private repos.** The index lags hours after creation, sometimes stays empty entirely. `getRepoTree` uses `/repos/{repo}/git/trees/{branch}?recursive=1` instead — that endpoint is always current. The classifier prompt explicitly tells the model the directory listing is authoritative and to fall back to it when search returns 0 results.

### Multi-project per client

- `ClientRecord.projects[]` (not `ClientRecord.repo`). Always resolve the active project via `getActiveProject(client)` from `src/lib/kv.ts`. There's a read-time normalizer in `getClient()` that lifts legacy single-repo records into the new shape.
- KV functions that store per-classification or per-conversation state are **project-scoped**: `getPending(env, tg_user_id, project_id)`, `findRecentActivity(env, tg_user_id, project_id)`, etc. The handler threads `activeProject.id` through these calls.
- Project switching: `/use <slug>` and `/projects` are client commands. Inline-keyboard picker in `src/lib/picker.ts`. Per-chat command menu sync via `syncChatMenu` in `src/lib/menu.ts`.

### Telegram messaging

- **`tg.sendMessage` is plain text by default.** Opt into rich formatting explicitly via `{ parseMode: "HTML" }`. Only two callers do: `notifyIdo` (uses `<b>` + `<a href>` for the Ido digest, `src/pipeline/notifier.ts`) and the shadow-mode trace block (`<pre>` blocks, `src/handlers/telegram.ts`) — both run every interpolated value through `escapeHtml()`. Everything else — admin replies, classifier acks, closure DM, error replies — sends plain text, robust to any user content. We use HTML, **not** Markdown, deliberately: a project id `Feedback_Bot` once crashed the Worker because Telegram's *Markdown* parser saw `_` as an unclosed italics entity, the worker returned 500, and Telegram's retry of the bad update crowded out subsequent `/use` and `/admin list` messages until they timed out. HTML formatting with an explicit `escapeHtml()` boundary avoids that whole class of bug.

### Classifier prompt + Opus 4.8 behavior

- **Issue body is English.** Title is English. Only `client_reply_he` (the Telegram acknowledgement to the client) is Hebrew. The `body_he` field name is a legacy artifact — its CONTENT is English. Reason: issues are eventually fed to coding agents, and English bodies materially improve their output.
- **The classifier runs on `claude-opus-4-8`** (`src/lib/ai.ts`, `effort: "high"` — the recommended minimum for intelligence-sensitive triage; Opus respects effort more strictly than Sonnet, "medium" under-thinks). The closure-DM summary (`src/pipeline/closure.ts`) stays on `claude-sonnet-4-6` (cheap, non-judgment).
- **Opus 4.8 calibrates opposite to the old Sonnet tuning.** It (a) reaches for tools *more conservatively* — so trigger conditions live in the tool descriptions (`src/tools/definitions.ts`) and the prompt tells it to ground proactively; (b) is *more deliberate / asks more* on minor decisions — countered by explicit "developer-side choices go in the body, don't ask" autonomy guidance; (c) *narrates more* between tool calls — countered by a work-directly instruction (that inter-tool prose is discarded by the loop anyway). It follows clear instructions faithfully, so measured "Call X when [signal]" phrasing lands well — no need to soften MUST/ALWAYS the way Sonnet required.
- **`max_tokens = 12288`** in `src/lib/ai.ts`. The final turn shares this budget across adaptive thinking + the structured English body; 4096 truncated mid-JSON on Sonnet, and 8192 left too little headroom once on Opus (deeper thinking at effort "high" + ~5-15% higher token counts). Truncation surfaces as stop_reason "max_tokens" and fails the loop. Stay under ~16K (non-streaming SDK timeout). Don't lower without re-testing on real workloads.
- Cache breakpoint goes after the stable preamble + per-repo context. The directory listing is large but stable per-repo for 6h (KV cache), so cache hit rates stay high — verified `cache_read_input_tokens` ~8K against ~14K input.

---

## Operational

- **Live URL:** `https://<your-worker>.<your-subdomain>.workers.dev`
- **GitHub App:** `workfluxs-feedback-bot`, App ID `<your-app-id>`, installation `<your-installation-id>` on `idoZ-H` (User account, all-repos selection).
- **GCS bucket:** `workfluxs-feedback-media` in project `<your-gcp-project-id>`. Service account `<your-service-account>@…` has `Storage Object Admin` on the bucket; cannot create buckets.
- **Telegram webhook URL:** `<worker>/telegram/webhook`, secret pre-shared (`TELEGRAM_WEBHOOK_SECRET`). `allowed_updates: ["message", "callback_query"]` — re-run `setWebhook` after schema changes that add update types, or callback-query taps silently never reach the Worker.
- **GitHub webhook:** registered centrally on the App (single URL for all installations). No per-repo webhook setup needed.
- **Deploy:** `npx wrangler deploy` (esbuild bundles; `nodejs_compat` flag enabled in `wrangler.toml`).
- **Wrangler version:** v4.90.0+. Older v3.x had OAuth login bot-challenge issues; if the user can't `wrangler login`, recommend creating a Cloudflare API token with the "Edit Cloudflare Workers" template.
- **Live debug:** `CLOUDFLARE_API_TOKEN=$(grep ^CLOUDFLARE_API_TOKEN= .env | cut -d= -f2-) npx wrangler tail --format pretty` streams Worker logs with stack traces. **`tail` is live-only — there is no log history** (no Workers Logs / Logpush configured), so you cannot inspect what a *past* action did. Start the tail FIRST, then trigger the thing you're debugging (send a Telegram message, click `/admin/index-status` → rebuild, or wait for the cron). Past logs are unrecoverable.
- **Don't `source .env`.** The multi-line `GCS_SERVICE_ACCOUNT_JSON` value breaks bash — `source` interprets the JSON keys as commands. Extract individual keys with `grep ^KEY= .env | cut -d= -f2-` instead.
- **Worker secrets are write-only.** `wrangler secret put` stores them; nothing reads them back. There is **no `wrangler secret get`** — `wrangler secret list` returns names + type only, never values. To rotate `TELEGRAM_WEBHOOK_SECRET`: `openssl rand -hex 32` → pipe to `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET` (auto-deploys with the new secret) → `setWebhook` with the new value. Same path for any secret you can't dig out of a password manager.
- **Local `.env` ≠ deployed secrets.** The local `.env` holds only a subset (dev/CLI tokens like `CLOUDFLARE_API_TOKEN`, `ANTHROPIC_API_KEY`). Deploy-only secrets — `TELEGRAM_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GCS_BUCKET` — exist **exclusively as Worker secrets** and are not in `.env`. Consequence: you **cannot call internal endpoints from your laptop** (e.g. `POST /internal/index-step`, whose auth is `X-Internal-Secret: TELEGRAM_WEBHOOK_SECRET`) — the secret isn't there, you get 401. Debug via `wrangler tail` + an in-app trigger instead, not by curling internal routes.

## Retrieval pipeline (embed → over-fetch → rerank → HyDE)

- **Two-stage retrieval.** `retrieveCode` (`src/pipeline/code-index.ts`) embeds the query with the bge prefix, over-fetches `RETRIEVAL_CANDIDATE_K=24` candidates from Vectorize, then narrows to `RETRIEVAL_TOP_K=6` with the **cross-encoder reranker `@cf/baai/bge-reranker-base`** (`rerankChunks` in `src/lib/vectorize.ts`). The bi-encoder cosine band is narrow/uncalibrated (~0.71–0.74 even for the right chunk); the reranker reorders within that band and returns a calibrated [0,1] relevance score. Reranker takes the RAW query, not the bge embedding prefix. Adds one `env.AI.run` per `github_search_code` call (neuron cost) — `bge-reranker-base` must be on the Workers AI plan.
- **HyDE.** `github_search_code` now requires a `semantic_query` field (`src/tools/definitions.ts`): a one-sentence natural-language hypothesis the model writes, used for the embedding while the keyword `query` still drives GitHub code search. Dispatcher routes them in `src/tools/dispatch.ts`.
- **Grounding signal + low-grounding flag.** `ToolDispatcher.getGrounding()` accumulates github match counts + top semantic score across a ticket. `isLowGrounding()` flags the documented failure (github code search empty + weak/no semantic match); the handler passes it to `notifyIdo` (a `⚠️ low grounding` digest line) and into the classification record.
- **Classification records.** Every classification writes a `ClassificationRecord` (outcome + grounding + token cost) via `recordClassification` to the `CLASSIFICATIONS` KV namespace (**provisioned + live in prod 2026-06-15**, id in the gitignored `wrangler.toml`; 90-day TTL). The binding is still typed optional in `Env` so writes/reads no-op gracefully where it's absent (e.g. `wrangler.test.toml`). Read recent via `getRecentClassifications` — **note: no admin view consumes it yet**, so records accumulate but aren't surfaced anywhere until a reader is built. Spend is priced from real Opus 4.8 token usage (`estimateClassifierCostCents`, `src/pipeline/rate-limit.ts`), not the old flat 1¢.
- **Eval gate.** `npm run eval` scores `eval/golden-set.json` (gitignored) or falls back to the committed synthetic `eval/golden-set.sample.json`. `tests/unit/eval-harness.test.mjs` gates the scoring pipeline + sample in CI (recall floor 0.8). The live retriever can't run offline, so this gates the harness, not real retrieval.
- ⚠️ The reranker + HyDE change live classification behavior — validate on real workloads before trusting (per the Opus-tuning caveats above).

## Semantic code index — ops & debugging

- **Inspect prod state via KV (read-only, safe).** Per-repo index manifests live in the `CODE_INDEX_META` namespace, keyed by `owner/repo`; client records live in `CLIENTS`, keyed by `tg_user_id`. Get the binding→namespace-id map from the **gitignored `wrangler.toml`** (not committed — don't hardcode the ids here), then: `wrangler kv key get --namespace-id=<id> "owner/repo" --remote` and `wrangler kv key list --namespace-id=<id> --remote`. A manifest's `status` goes `building` → `complete`; `cursor` / `chunk_count` show progress. **No manifest = never indexed.**
- **Three index triggers, in reliability order.** (1) Best-effort kickoff on repo add / rebuild — `continueIndexBuild` under `ctx.waitUntil`, which self-fetches `/internal/index-step`; *can be silently dropped*. (2) The `*/30` cron (`runIndexMaintenance`) — the reliable safety-net. It **bootstraps brand-new semantic-enabled repos that have no manifest yet**, but is bounded to `MAX_REPOS_PER_TICK=2` / `MAX_SLICES_PER_TICK=2`, so a just-added repo can take **up to ~30 min to even start**, longer to finish. (3) Lazy ingest on the next client message. **A freshly added repo not indexing in the first few minutes is expected timing, not a bug** — the cron picks it up on the next tick.
- **Force an index now:** `/admin/index-status` → **rebuild** (deletes the manifest, re-kicks the build), or have the client send any message (lazy path). Build failures are swallowed (`code_index_build_failed`, handler still returns 200) — the actual error is **only** visible via `wrangler tail` during a live attempt, so tail first, then click rebuild.
- **Cross-owner repos are supported.** `getInstallationToken` resolves the installation per-repo (`GET /repos/{repo}/installation`), so any owner the GitHub App is installed on is indexable — not just `idoZ-H`. Repo-add validation calls this same function, so **a successful `/admin add` proves the App is installed on that owner**; if the add succeeded, the installation/token is not your indexing failure.

## workerd process leak — guardrails (do not remove)

`wrangler dev` spawns `workerd` children. When wrangler dies ungracefully (VS Code/SSH terminal closed → SIGHUP, crash, or SIGKILL) the workerd children are orphaned to PID 1 and leak — one incident reached **328 orphaned workerd / ~5.7 GB**, filling RAM and swap. Three guardrails prevent recurrence:

- **`dev.sh`** — `npm run dev` runs through this wrapper. It traps `INT`/`TERM`/`HUP`/`EXIT` and sweeps leftover workerd on exit (covers Ctrl-C, terminal close, crash). The raw command is preserved as `npm run dev:raw`. Running `npx wrangler dev` or `dev:raw` directly bypasses this layer.
- **`scripts/reap-orphan-workerd.sh`** — cron every 10 min (`crontab -l`). Kills only workerd whose parent is **PID 1**. A live `wrangler dev` keeps workerd as its own children, never PID 1, so this can never touch a running dev server. Backstops the SIGKILL case the wrapper can't trap. Logs to `scripts/reap-orphan-workerd.log` only when it reaps.
- **Manual cleanup:** `bash scripts/reap-orphan-workerd.sh`. To check for a leak: `ps aux | grep -c '[w]orkerd'` (healthy = a handful; a leak = dozens–hundreds).

## Tests

- `npm test` — all 533 tests via vitest-pool-workers (real Miniflare KV).
- `npm run typecheck` — tsc --noEmit. Currently clean (zero errors), with `noUncheckedIndexedAccess` enabled in `tsconfig.json`.
- The compatibility-date warning during tests (`requested 2026-01-01 vs runtime 2024-12-30`) is harmless — workerd just falls back to its supported max.
- `tests/stubs/langsmith*.ts` are the langsmith aliases for the test runtime; do not delete.
- `vitest.config.ts` excludes `.worktrees/` so isolated workspaces don't get scanned.

## Branches & worktrees

- `master` is the integration branch (not `main`).
- We use `git worktree` for isolated feature work; the convention is `.worktrees/<branch-slug>/` (gitignored).
- Two recent merges into master: `feat/multi-project-per-client` (multi-project foundation) and `feat/english-issue-bodies` (codebase grounding + LangSmith). Both have full history preserved via `--no-ff` merge commits.

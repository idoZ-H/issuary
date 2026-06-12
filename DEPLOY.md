# Deploy guide

A full walkthrough from an empty Cloudflare account to a running bot with one
client. Reckon 30–60 minutes the first time, including the GitHub App setup.

The short version (after you've done it once) is in [README.md](README.md);
this page exists for the first-time setup.

## Prereqs

You'll need accounts on:

- [Cloudflare](https://dash.cloudflare.com) — Workers + KV (free tier OK)
- [Telegram](https://t.me/BotFather) — a bot from `@BotFather` (free)
- [Anthropic](https://console.anthropic.com) — API key with credit
- [GitHub](https://github.com/settings/apps/new) — a GitHub App (free)
- [Google Cloud](https://console.cloud.google.com) — a Service Account + a
  GCS bucket + Gemini API access (free tier OK)
- Optional: [LangSmith](https://smith.langchain.com) for classifier tracing

## 1. Clone, install, configure

```bash
git clone https://github.com/idoZ-H/issuary
cd issuary
npm install
cp .env.example .env
cp wrangler.toml.example wrangler.toml
```

Edit `.env` later (after you've collected the values below). `wrangler.toml`
gets KV ids in the next step.

## 2. Cloudflare login + KV namespaces

```bash
npx wrangler login
```

If `wrangler login`'s OAuth flow trips on a bot-challenge (some setups do),
make a Cloudflare API token at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
with the "Edit Cloudflare Workers" template and export it as
`CLOUDFLARE_API_TOKEN`.

Create all twelve KV namespaces:

```bash
for ns in CLIENTS ADMINS REPO_CONTEXT RECENT_ACTIVITY \
          PENDING_CLASSIFICATION CONVERSATION_HISTORY RATE_LIMITS \
          ISSUE_TO_CHAT DEDUP ADMIN_SESSIONS ISSUE_LIST_CACHE \
          CODE_INDEX_META; do
  npx wrangler kv namespace create "$ns"
done
```

Each call prints an `id`. Paste each into the matching binding block in
`wrangler.toml`, replacing `<your-kv-id>`. Order doesn't matter — bindings
are looked up by `binding` name.

### Workers AI + Vectorize (semantic code retrieval)

The classifier can ground issues and clarifying questions in actual repo code
via semantic retrieval (currently **shadow-only** — see "Shadow mode"). It needs
a Workers AI binding (no provisioning — just the `[ai]` block in `wrangler.toml`)
and one Vectorize index with a metadata index on `repo`:

```bash
npx wrangler vectorize create feedback-code-index --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index feedback-code-index --property-name=repo --type=string
```

The `[ai]` and `[[vectorize]]` blocks are already in `wrangler.toml.example`.
Note: the Workers runtime in `vitest-pool-workers` cannot emulate a Vectorize
binding, so those two blocks must be **absent** from the `wrangler.toml` used by
`npm test`. Keep them in your deploy config only. (`CODE_INDEX_META` is fine in
tests — the vitest config provisions it as a Miniflare KV namespace.)

## 3. Create a GitHub App

Go to [github.com/settings/apps/new](https://github.com/settings/apps/new)
(or your org's apps page) and fill in:

- **Name:** anything, e.g. `<yourname>-feedback-bot`
- **Homepage URL:** anything (your Worker URL once you have it)
- **Webhook URL:** `<your-worker-url>/github/webhook` — you'll have the
  Worker URL after the deploy in step 6; for now leave it as
  `https://example.com` and update it in step 8
- **Webhook secret:** generate one with `openssl rand -hex 32`, save it as
  `GITHUB_WEBHOOK_SECRET` in `.env`
- **Permissions → Repository:**
  - Contents: Read-only
  - Issues: Read & write
  - Metadata: Read-only (default)
- **Subscribe to events:** Issues
- **Where can this app be installed:** Only on this account

After "Create GitHub App":

1. Copy the **App ID** (numeric, at the top of the settings page) → `GITHUB_APP_ID` in `.env`
2. "Generate a private key" → downloads a `.pem` file. Paste the entire
   contents (including BEGIN/END markers) into `GITHUB_APP_PRIVATE_KEY` in
   `.env`, quoted with single quotes.
3. Click **Install App** in the sidebar → pick the account/org → "All
   repositories" (easiest) or "Only select repositories". The bot can only
   file issues on installed repos.

## 4. Google Cloud — bucket + Gemini

In a Google Cloud project of your choosing:

1. Create a GCS bucket for media. Name it whatever, e.g.
   `<yourname>-feedback-media`. Save the name as `GCS_BUCKET` in `.env`.
2. Create a service account with the **Storage Object Admin** role on that
   bucket. Generate a JSON key, download it.
3. Paste the full JSON into `GCS_SERVICE_ACCOUNT_JSON` in `.env`, quoted with
   single quotes.
4. Enable the Generative Language API
   ([console](https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com))
   in the same project. Create an API key, save as `GEMINI_API_KEY` in
   `.env`.

## 5. Fill in `.env` and upload all the secrets

By now `.env` should have values for:

```
TELEGRAM_BOT_TOKEN          (from @BotFather)
TELEGRAM_WEBHOOK_SECRET     (openssl rand -hex 32)
ANTHROPIC_API_KEY           (Anthropic console)
GEMINI_API_KEY              (GCP API key, step 4)
GITHUB_APP_ID               (step 3)
GITHUB_APP_PRIVATE_KEY      (step 3, full PEM)
GITHUB_WEBHOOK_SECRET       (step 3)
GCS_SERVICE_ACCOUNT_JSON    (step 4, full JSON)
GCS_BUCKET                  (step 4)
IDO_TG_USER_ID              (your own tg_user_id — DM the bot once, check wrangler tail logs)
IDO_INBOX_CHAT_ID           (a private Telegram channel ID where the bot can post digests; create one and add the bot as admin)
```

Upload them all as Worker secrets:

```bash
for k in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET GITHUB_WEBHOOK_SECRET \
         ANTHROPIC_API_KEY GEMINI_API_KEY GCS_SERVICE_ACCOUNT_JSON \
         GCS_BUCKET GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY \
         IDO_TG_USER_ID IDO_INBOX_CHAT_ID; do
  grep "^$k=" .env | cut -d= -f2- | npx wrangler secret put "$k"
done
```

> **Don't `source .env`** — the multi-line `GCS_SERVICE_ACCOUNT_JSON` and
> `GITHUB_APP_PRIVATE_KEY` values break bash if you do.

If you want LangSmith tracing, also set:

```bash
echo "true"          | npx wrangler secret put LANGSMITH_TRACING
grep ^LANGSMITH_API_KEY= .env | cut -d= -f2- | npx wrangler secret put LANGSMITH_API_KEY
echo "feedback-bot"  | npx wrangler secret put LANGSMITH_PROJECT
```

## 6. Deploy

```bash
npx wrangler deploy
```

Capture the printed Worker URL. Health check:

```bash
curl https://<your-worker>.workers.dev/
# → {"ok":true,"service":"issuary","version":"1.0"}
```

## 7. Register the Telegram webhook

```bash
TOKEN="$(grep ^TELEGRAM_BOT_TOKEN= .env | cut -d= -f2-)"
SECRET="$(grep ^TELEGRAM_WEBHOOK_SECRET= .env | cut -d= -f2-)"
WORKER_URL="https://<your-worker>.workers.dev"

curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H "content-type: application/json" \
  -d "{
    \"url\":\"${WORKER_URL}/telegram/webhook\",
    \"secret_token\":\"${SECRET}\",
    \"allowed_updates\":[\"message\",\"callback_query\"]
  }"
```

Expected: `{"ok":true,"result":true,"description":"Webhook was set"}`.

> `allowed_updates` is required for the inline-keyboard project picker.
> Telegram drops update types not in the allowlist at its edge before they
> reach the Worker.

## 8. Point the GitHub App webhook at your Worker

Back in your GitHub App settings, edit the **Webhook URL** to:

```
https://<your-worker>.workers.dev/github/webhook
```

The webhook drives the closure flow: when you close an issue on GitHub, the
client gets a "fixed" DM in their language.

## 9. Make yourself the first admin

DM the bot any message from your Telegram. Then watch the logs to capture
your `tg_user_id`:

```bash
CLOUDFLARE_API_TOKEN="$(grep ^CLOUDFLARE_API_TOKEN= .env | cut -d= -f2-)" \
  npx wrangler tail --format pretty
```

(Or read it from your Telegram client URL — DM yourself on the web, the URL
ends in `?p=u<your-id>`.)

Once you have it:

```bash
npx wrangler kv key put --binding=ADMINS \
  "<YOUR_TG_USER_ID>" '{"role":"admin"}' --remote
```

## 10. Sign in to `/admin` and add a client

Visit `https://<your-worker>.workers.dev/admin`, enter your `tg_user_id`,
click the magic link from your Telegram DM (valid 10 minutes).

From the **Clients** page:

1. Click **+ add client**
2. Enter their `tg_user_id`, name, the GitHub repo (`owner/repo` — the App
   must be installed on it), and optionally a Hebrew display name
3. The first project becomes the default. Add more via the client detail
   page.

You can also do all of this from your own Telegram with `/admin`
commands — see [`docs/operations.md`](docs/operations.md) for the full list.

## 11. Smoke test

From the client's Telegram, DM the bot:

1. `"hi"` (or any chit-chat) → reply, no GitHub issue.
2. `"the X button doesn't work"` + screenshot → expect an issue on the right
   repo, a digest in your `IDO_INBOX_CHAT_ID` channel, and an acknowledgement
   DMed to the client.
3. Close the issue on GitHub → expect a "fixed" DM to the client in their
   language.

Tail logs while testing:

```bash
CLOUDFLARE_API_TOKEN="$(grep ^CLOUDFLARE_API_TOKEN= .env | cut -d= -f2-)" \
  npx wrangler tail --format pretty
```

## Shadow mode

For the first week of any new client, toggle **shadow mode** on (from the
`/admin/clients/<id>` page). While shadow is on, the bot still creates
issues normally but also posts a copy of the raw client message + the
classifier output to your `IDO_INBOX_CHAT_ID` channel. Use it to catch
mis-classifications before they become problems. Toggle off after 7 clean
days.

If the Workers AI + Vectorize bindings are configured, shadow mode also warms
the semantic code index for the client's repo and appends a **"Semantic
retrieval (shadow)"** block to each shadow trace — showing the file/line chunks
that semantic search *would* have surfaced for every `github_search_code` query.
Compare it against what GitHub code search returned: if semantic retrieval
consistently points at better files, that's the signal to promote it from a
shadow comparison to the live code-finding tool (replacing `github_search_code`).

## Rotating secrets

Worker secrets are write-only via `wrangler secret put`. To rotate:

```bash
echo "<new-value>" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# Re-register the Telegram webhook with the new secret (step 7).
```

Same pattern for any other secret.

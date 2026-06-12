# Operations reference

Day-to-day operator commands. Everything here also has an equivalent in the
`/admin` web UI — pick whichever surface you prefer. The Telegram commands
are convenient because you're already in Telegram talking to the bot.

You must be in the `ADMINS` namespace for any of these.

## Add a single-project client

```
/admin add <CLIENT_TG_USER_ID> "Client Name" <owner/repo>
```

The bot creates the client record, sets a per-chat command menu (just
`/start` and `/help` — no multi-project commands shown), and stays out of
the way.

## Add a second project to an existing client

```
/admin add <CLIENT_TG_USER_ID> "Client Name" <owner/repo2> <project_id> "<Hebrew project name>"
```

On the 1→2 transition the bot:

- Adds the project to `client.projects[]`.
- Refreshes the client's per-chat command menu to include `/use` and
  `/projects`.
- Sends a one-time onboarding DM with an inline-keyboard picker.
- Marks `welcomed_multi_at` so the onboarding never fires again.

For a 3rd, 4th, … project, use the same command. The bot sends a brief
`added project: <name>` notice instead of the full onboarding.

## Switch a client's default project

The default is used as the fallback when the active project is removed.

```
/admin set-default <CLIENT_TG_USER_ID> <project_id>
```

## Remove a project (keeps the client)

```
/admin remove-project <CLIENT_TG_USER_ID> <project_id>
```

Refuses if it would leave the client with zero projects. If the removed
project was active, the bot falls back to the default, then to the first
remaining project, and DMs the client which one is now active.

## Remove a client entirely

```
/admin remove <CLIENT_TG_USER_ID>
```

## List everything

```
/admin list
```

Output shape:
`<tg_user_id>: <name> → *<active_id> (<repo>), <other_id> (<repo>) (active|inactive)`.
The `*` prefix marks the active project.

## Client-side commands

Single-project clients see only `/start` and `/help`. Multi-project clients
additionally see:

- `/use <project_id>` — switch active project (typed form).
- `/use` (no arg) or `/projects` — show the inline-keyboard picker.

The bot enforces this menu per-chat via `setMyCommands` with
`BotCommandScopeChat`, so single-project clients literally never see `/use`
in their UI even though the worker would handle it.

## Adding another admin

DM the bot once from the new admin's Telegram account so the worker logs
their `tg_user_id`. Then either:

- From `/admin/admins` in the web UI, paste the id, click **add admin**, or
- From the CLI:

  ```bash
  npx wrangler kv key put --binding=ADMINS "<TG_USER_ID>" '{"role":"admin"}' --remote
  ```

## Troubleshooting

- **Bot ignores picker taps:** check that `setWebhook` was registered with
  `allowed_updates: ["message","callback_query"]`. Telegram drops update
  types not in the allowlist at its edge before they reach the worker. See
  [DEPLOY.md](../DEPLOY.md) step 7.
- **"App not installed on …":** the GitHub App needs to be installed on
  every client repo. The classifier auth path uses installation tokens, not
  PATs. The bot DMs the operator a clear error and tells the client to wait.
- **"Request forbidden by administrative rules" (GitHub):** GitHub rejects
  fetch requests with no User-Agent. The worker sets one explicitly; if you
  fork or copy this code, keep that header.
- **Live logs:**

  ```bash
  CLOUDFLARE_API_TOKEN="$(grep ^CLOUDFLARE_API_TOKEN= .env | cut -d= -f2-)" \
    npx wrangler tail --format pretty
  ```


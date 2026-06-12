# Domain context — feedback-bot

Shared vocabulary for the system. Names here are the canonical terms; code,
commits, and architecture reviews should use them rather than inventing
synonyms.

## Core entities

**Client**
A person who reaches the bot from one Telegram chat. Persisted as a
`ClientRecord` in the `CLIENTS` KV namespace, keyed by `tg_user_id`. A client is
`active` or not, may be in `shadow_mode`, and owns one or more **Projects**.

**Project**
A single GitHub repo a client can file feedback against, plus its settings
(`semantic_enabled`, name shown in the Telegram menu, etc.). A client always has
exactly one **active project** (where new feedback lands) and one **default
project**; both invariants must always point at a surviving project.

**Active project / default project**
The active project is the one a client's next message is filed against; the
default is the fallback restored when the active project is removed. Resolved via
`getActiveProject(client)`.

## Pipeline concepts

**Classifier**
The Claude-driven step that turns a client message into a structured
`ClassifierOutput` (issue-or-not, type, severity, Hebrew client reply, English
issue body). Its output is validated as a complete discriminated union at one
seam (`parseClassifierOutput`) — past that seam the type is trusted.

**Code Index**
The per-repo semantic index (chunk → embed → Cloudflare Vectorize) that grounds
the classifier in the client's codebase. Built incrementally from GitHub push
webhooks and reconciled by a cron blob-SHA diff.

## Administration

**Client Administration** (`src/lib/client-admin.ts`)
The deep module that owns every client/project mutation: validation, repo
conflict detection, the active/default invariant repair, the KV write, and the
side effects (Telegram menu sync, index-build kickoff). It is the single
implementation behind two **surfaces**:

- the **Telegram admin surface** — `/admin` commands (`src/handlers/admin.ts`)
- the **web admin surface** — the dashboard (`src/admin/pages/clients.ts`)

Each surface is a thin adapter: it parses its own input, calls the module, and
maps the structured result to its own presentation (Hebrew Telegram replies vs
HTML redirects). New client/project mutations belong in the module, not in a
surface.

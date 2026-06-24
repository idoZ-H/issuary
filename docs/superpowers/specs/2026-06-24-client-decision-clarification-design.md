# Design: Route business-logic decisions to the client, not the developer

**Date:** 2026-06-24
**Status:** Approved (brainstorming) — pending implementation plan
**Area:** classifier prompt, tool definitions, dispatcher, telegram handler, pending-state types

## Problem

The classifier turns client Telegram messages into GitHub issues. Issues are
later handed to a coding agent (a separate Claude Code session) to implement via
PR. When that coding agent hits an unresolved **business/product** decision in
the issue body, it bounces the question back to the developer (Ido) — who cannot
answer it. Only the client can.

### Ground truth (LangSmith, feedback-bot project, 2026-06-24)

Two-turn conversation:

- **Turn 1 (07:21)** — client: *"אני רוצה לשנות את איפה שרואים כשמישהו מסמן אי הגעה"*
  ("I want to change where you see no-shows").
  Classifier correctly asked **one** clarifying question (which screen, what to change).
- **Turn 2 (07:23)** — client: *"כרגע המידע מופיע בדשבורד ניהול - אני רוצה שהוא **יעבור**
  למסך הנוכחות..."* ("currently it's in the admin dashboard — I want it to **move**
  to the attendance screen...").
  Classifier produced a well-grounded feature issue, but ended the body with:

  > ## Open questions (for the developer)
  > Should absences be fully removed from the admin dashboard, or also kept there?
  > (client said "move" — confirm if dashboard display should be dropped or just added.)

That question — "relocate vs. duplicate?" — is **not** a developer decision. It is
a pure product choice only the client can make. The Hebrew word *"יעבור" (move)*
is genuinely ambiguous. The coding agent later surfaced it to Ido, who couldn't
resolve it.

### Root cause (two compounding factors)

1. **Taxonomy mis-route.** A client-only decision was labeled *"(for the developer)"*
   and dumped in the body (`src/prompts/classifier.ts:48`, `:65`). It should have
   been recognized as client-facing.
2. **Hard one-question budget.** Even had it been recognized, the prompt forbids a
   second question on the answer turn (`classifier.ts:207`), and the per-run
   dispatcher cap is `MAX_CLARIFICATIONS = 1` (`src/tools/dispatch.ts:36`). The
   body was the model's only outlet. Note the new client-decision ("move") only
   *emerged* in the client's turn-1 answer — it could not have been bundled into
   the turn-1 question.

## Constraint

The user explicitly does **not** want the model to always ask questions
(over-asking annoys clients). The fix must let genuine business questions reach
the client **without** turning the classifier into an interrogator on clear reports.

## Decision

Resolve client-only ambiguities **at intake (push)** — ask the client before the
issue is written — gated by a strict 3-part test and a hard ceiling of **2
questions per ticket**. Anything that fails the gate or exceeds the cap is written
into a correctly-labeled `## ⚠️ Needs client decision` body section instead of
dead-ending under the developer heading.

### The gate — ask a follow-up only when ALL three hold

1. **Client-only** — the unresolved point is a decision only the client can make
   (target value, scope, end-state, business behavior), never a technical one.
2. **Outcome-changing** — getting it wrong changes *what gets built* in a
   client-visible way, not an internal/cosmetic detail.
3. **No safe default** — there is no reasonable default the client could cheaply
   correct later. (If one exists, default-and-flag instead of asking.)

If any fails → do not ask; write the issue, recording the point under the correct
section.

### Hard ceiling

**Max 2 clarifying questions per ticket, total**, enforced by the dispatcher
(survives across turns via the pending-state counter). If a blocking client
decision still remains after 2 questions, stop asking and write it under
`## ⚠️ Needs client decision`.

## Components

### 1. Pending-state counter (`src/types.ts:108`)
`PendingClassification` gains `questions_asked?: number` (**optional** — existing
test fixtures and legacy KV records omit it; read with `?? 0`). Written as
`(prior ?? 0) + 1` when a question is sent; read back on the answer turn to compute
the ticket-level total.

### 2. Dispatcher ticket-level cap (`src/tools/dispatch.ts`)
- Constructor gains `priorQuestionsAsked: number = 0` as the **last** param (after
  `retrieveActive`), from `pending?.questions_asked ?? 0`. Last position keeps all
  existing positional call sites and tests working.
- Rename `MAX_CLARIFICATIONS` → `MAX_TICKET_CLARIFICATIONS = 2`.
- Clarify branch rejects when **either** `clarificationCount >= 1` (per-run cap —
  the loop pauses after one ask; preserves the existing "rejects a second ask in
  one run" test) **or** `priorQuestionsAsked + clarificationCount >= 2`
  (ticket-level ceiling across turns). Rejection content tells the model to write
  the issue and put any remaining client-only decision under
  `## ⚠️ Needs client decision`.
- The send-callback (in the handler) writes `questions_asked: priorQuestionsAsked + 1`
  into the new pending state.

### 3. Answer-turn prompt instruction (`src/prompts/classifier.ts:203-208`)
The prompt builder's `pending_clarification` arg gains `questions_asked: number` so
the instruction is actionable. Render conditionally:
- If `questions_asked >= 2`: *"You have already asked the client the maximum (2
  questions). Do NOT ask again — produce a final classification, placing any
  remaining client-only decision under `## ⚠️ Needs client decision`."*
- Else (`questions_asked === 1`): flip from *"Do not ask another clarifying
  question"* to *"This is the client's answer. Produce a final classification
  UNLESS a **new** client-only decision emerged from their answer that passes the
  gate — then you may ask exactly ONE more focused question."*

The dispatcher (component 2) is the hard backstop if the model ignores this.

### 4. The gate, in prompt + tool description
- Clarifying-policy section (`classifier.ts:56-72`): add the explicit 3-part gate.
- `ask_clarifying_question` description (`src/tools/definitions.ts:9`): change
  *"at most once per ticket"* → *"at most twice per ticket, and only when [gate]"*.
  (Opus 4.8 honors trigger conditions stated in the tool description.)

### 5. Taxonomy fix — two distinct body sections (`classifier.ts:48`, `:65`, few-shot)
- `## Open questions (developer decides)` — technical only.
- `## ⚠️ Needs client decision` — business questions that survived (gate failed or
  budget hit).
- Business/product decisions must **never** appear under the developer heading.
- Add a few-shot example built from this trace ("move = relocate or duplicate?")
  to teach the boundary by the real failure. Update existing Example 4's
  *"Open questions (for the developer)"* heading to the new wording for consistency.

### 6. Handler wiring (`src/handlers/telegram.ts`)
No delete-pending guard needed — the `clarify` result branch (`telegram.ts:~331`)
returns early and never reaches the `deletePending` line, which runs only on a
`final` result. Two changes:
- Thread `pending?.questions_asked ?? 0` into the dispatcher constructor as the
  last arg (`telegram.ts:239`).
- In the send-clarifying callback (`telegram.ts:241`), write
  `questions_asked: (pending?.questions_asked ?? 0) + 1` into `putPending`.
- Pass `questions_asked: pending.questions_asked ?? 0` into
  `buildClassifierSystem`'s `pending_clarification` arg (`telegram.ts:182`).

## Net behavior

The absence case resolves at intake: after the client says "move," the gate fires
once more ("relocate, or also keep it on the dashboard?"), the client answers, and
the issue is written with zero open business questions. The hard cap + gate keep
it from interrogating clients on clear, complete reports.

## Testing (TDD)

- **Dispatcher cap:** rejects the 3rd clarification; allows the 2nd when
  `priorQuestionsAsked === 1`; rejects the 2nd when already at 2; counter
  increments correctly in the written pending state.
- **Pending counter persistence:** `questions_asked` round-trips through KV.
- **Prompt builder:** with `pending_clarification.questions_asked === 2`, the system
  text contains the "do NOT ask again" instruction; with `=== 1`, it contains the
  gated "you may ask ONE more" instruction.
- **Taxonomy (classify-stub):** a business-decision output never renders under the
  developer heading; it renders under `## ⚠️ Needs client decision`.
- Gate behavior (a prompt concern) is validated by replaying the real absence trace
  against the live classifier before trusting it, per the Opus-tuning caveats in
  CLAUDE.md.

## Out of scope

- The just-in-time / pull mechanism (routing implementation-time questions back to
  the client through the GitHub webhook). Considered and deferred in favor of
  intake-push.
- The already-filed absence issue: the developer can ask the client the one
  surviving question manually and update it. No migration needed.

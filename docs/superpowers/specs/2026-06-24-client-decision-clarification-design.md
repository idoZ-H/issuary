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
`PendingClassification` gains `questions_asked: number`. Written as `1` when the
first question is sent; read back on the answer turn to compute the ticket-level
total.

### 2. Dispatcher ticket-level cap (`src/tools/dispatch.ts`)
- Constructor gains `priorQuestionsAsked: number` (from `pending?.questions_asked ?? 0`).
- Clarify branch rejects when `priorQuestionsAsked + clarificationCount >= 2`.
- Correct the misleading "max one per ticket" comment (it is per-run today).
- The send-callback writes `questions_asked: priorQuestionsAsked + 1` into the new
  pending state.

### 3. Answer-turn prompt instruction (`src/prompts/classifier.ts:203-208`)
Flip from *"Do not ask another clarifying question — produce a final classification"*
to: *"This is the client's answer. Produce a final classification UNLESS a **new**
client-only decision emerged from their answer that passes the gate — then you may
ask exactly ONE more focused question. After two questions total, never ask again:
write the issue with the unresolved point under `## ⚠️ Needs client decision`."*

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

### 6. Handler — don't clobber a re-ask (`src/handlers/telegram.ts:337`)
The delete-pending line currently fires whenever the original `pending` was
truthy. Guard it so a second question's freshly-written pending state survives —
delete only on a **final** result, not a repeat `kind:"clarify"`. Thread
`pending?.questions_asked ?? 0` into the dispatcher constructor (`telegram.ts:239`).

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
- **Handler:** a repeat `kind:"clarify"` on the answer turn does NOT delete pending;
  a final result does.
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

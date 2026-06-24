# Client-Decision Clarification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the classifier resolve genuine client-only (business) decisions at intake via a strict 3-part gate and a hard ceiling of 2 clarifying questions per ticket, so those decisions never dead-end as "(for the developer)" open questions that the downstream coding agent bounces back to Ido.

**Architecture:** A ticket-level question counter rides in the `PENDING_CLASSIFICATION` KV state across turns. The `ToolDispatcher` enforces the hard cap (max 2 per ticket, max 1 per run). The classifier prompt + the `ask_clarifying_question` tool description carry the gate that decides *when* a second question is warranted, and split the issue body's open-questions into a developer section and a `## ⚠️ Needs client decision` section. The dispatcher is the hard backstop; the prompt is best-effort guidance.

**Tech Stack:** TypeScript, Cloudflare Workers, `@cloudflare/vitest-pool-workers` (real Miniflare KV), Anthropic SDK (Opus 4.8 classifier).

## Global Constraints

- Run all tests with `npm test` (vitest-pool-workers). Typecheck with `npm run typecheck` (tsc --noEmit, must stay at zero errors; `noUncheckedIndexedAccess` is on).
- Issue **body content is English**; only `client_reply_he` is Hebrew. The `body_he` JSON field name is legacy — its content is English.
- `CLASSIFIER_TOOLS` in `src/tools/definitions.ts` MUST stay alphabetically sorted by name and stable across requests — it is part of the cached prompt prefix; reordering invalidates the cache. Edit description text only; do not reorder.
- The classifier system prompt's stable preamble is a cache breakpoint — edits to `STABLE_PREAMBLE` are fine but keep it stable per-deploy.
- Opus 4.8 honors trigger conditions stated in tool descriptions and follows clear MUST/ALWAYS phrasing; no need to soften.
- Commit after each task. Work is on branch `feat/client-decision-clarification`.

---

### Task 1: Pending-state counter + dispatcher ticket-level cap

**Files:**
- Modify: `src/types.ts:108-114` (add optional `questions_asked`)
- Modify: `src/tools/dispatch.ts:35-85` (cap constant, constructor param, clarify-branch logic)
- Test: `tests/unit/tools-dispatch.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PendingClassification.questions_asked?: number`. `ToolDispatcher` constructor signature gains a trailing `priorQuestionsAsked: number = 0` (8th positional param, after `retrieveActive`). Exported constant `MAX_TICKET_CLARIFICATIONS = 2`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/tools-dispatch.test.ts` (alongside the existing clarification test at line 51):

```typescript
it("allows a second clarifying question across turns when one was already asked", async () => {
  const sendQ = vi.fn(async () => {});
  // priorQuestionsAsked = 1 (one asked on a previous turn)
  const d = new ToolDispatcher(gh as any, repo, sendQ, undefined, undefined, 1);
  const r = await d.dispatch({ name: "ask_clarifying_question", input: { question_he: "q2?", reason_en: "new client decision" } });
  expect(r.is_error).toBe(false);
  expect(r.pause_for_clarification).toBe(true);
  expect(sendQ).toHaveBeenCalledOnce();
});

it("rejects a clarifying question once the ticket already used both (priorQuestionsAsked=2)", async () => {
  const sendQ = vi.fn(async () => {});
  const d = new ToolDispatcher(gh as any, repo, sendQ, undefined, undefined, 2);
  const r = await d.dispatch({ name: "ask_clarifying_question", input: { question_he: "q3?", reason_en: "r" } });
  expect(r.is_error).toBe(true);
  expect(r.content).toMatch(/budget exhausted/i);
  expect(r.content).toMatch(/Needs client decision/i);
  expect(sendQ).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tools-dispatch`
Expected: the two new tests FAIL (the 6th constructor arg is ignored, so `priorQuestionsAsked=2` still allows the ask; and the rejection content lacks "Needs client decision").

- [ ] **Step 3: Add the optional counter to the type**

In `src/types.ts`, change the `PendingClassification` interface:

```typescript
export interface PendingClassification {
  raw_message_id: number;
  raw_message_text: string;
  attachments: AttachmentRef[];
  asked_question_he: string;
  asked_at: string;
  // Number of clarifying questions already asked across this ticket's turns.
  // Optional: legacy KV records and some test fixtures omit it — read with `?? 0`.
  questions_asked?: number;
}
```

- [ ] **Step 4: Update the dispatcher**

In `src/tools/dispatch.ts`, replace the constant (line 35-36):

```typescript
const MAX_TOOL_CALLS = 4;
// Hard ceiling on clarifying questions across ALL turns of one ticket. The
// per-run loop pauses after a single ask, so within one run at most one is sent;
// this cap spans the multi-turn conversation via priorQuestionsAsked.
export const MAX_TICKET_CLARIFICATIONS = 2;
```

Add the constructor param (after `retrieveActive` at line 66):

```typescript
    private readonly retrieveActive?: (query: string) => Promise<RetrievedChunk[]>,
    // Clarifying questions already asked on PRIOR turns of this ticket (from the
    // pending-state counter). Combined with this run's clarificationCount to
    // enforce MAX_TICKET_CLARIFICATIONS across turns. Defaults to 0 (fresh ticket).
    private readonly priorQuestionsAsked: number = 0
  ) {}
```

Replace the clarify branch guard (lines 70-74):

```typescript
    if (call.name === "ask_clarifying_question") {
      const totalAsked = this.priorQuestionsAsked + this.clarificationCount;
      // Per-run cap (loop pauses after one) OR ticket-level ceiling across turns.
      if (this.clarificationCount >= 1 || totalAsked >= MAX_TICKET_CLARIFICATIONS) {
        return {
          is_error: true,
          content:
            "Clarification budget exhausted (max 2 per ticket). Produce a final classification now; place any remaining client-only decision under a '## ⚠️ Needs client decision' section in the body, not under developer questions.",
        };
      }
      this.clarificationCount++;
```

(Leave the rest of the clarify branch — the `sendClarifyingQuestion` call and the `pause_for_clarification` return — unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tools-dispatch`
Expected: PASS — both new tests plus the existing "rejects a second ask_clarifying_question call" (which builds the dispatcher with `priorQuestionsAsked` defaulting to 0, so the per-run `clarificationCount >= 1` guard still rejects the same-run second ask).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/tools/dispatch.ts tests/unit/tools-dispatch.test.ts
git commit -m "feat: ticket-level 2-question clarification cap in dispatcher

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Handler wiring — thread the counter through

**Files:**
- Modify: `src/handlers/telegram.ts:182-184` (prompt arg), `:239-251` (dispatcher construction + callback)
- Test: `tests/unit/handler-telegram-full.test.ts`

**Interfaces:**
- Consumes: `ToolDispatcher(... , priorQuestionsAsked)` from Task 1; `PendingClassification.questions_asked` from Task 1; `buildClassifierSystem`'s `pending_clarification` arg (extended in Task 3 to accept `questions_asked` — see note below).
- Produces: on a sent clarifying question, the written pending record carries `questions_asked = (prior ?? 0) + 1`.

> **Ordering note:** Task 3 widens `buildClassifierSystem`'s `pending_clarification` type to include `questions_asked`. To keep this task compiling on its own, add `questions_asked` to the object passed at `telegram.ts:182` in THIS task (Step 3) — the field is accepted as excess until Task 3 consumes it (TypeScript object-literal excess-property checks would flag it, so do Task 3's `BuildArgs` change is required for typecheck to pass; run Tasks 2 and 3 together if executing strictly per-task, or accept that `npm run typecheck` is green only after Task 3). Tests in this task do not depend on Task 3.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/handler-telegram-full.test.ts`:

```typescript
it("records questions_asked=1 in pending when the classifier asks its first question", async () => {
  const fakeTg = {
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    react: vi.fn(async () => undefined),
    getFilePath: vi.fn(),
    downloadFile: vi.fn(),
  };
  const update = {
    update_id: 1,
    message: { message_id: 1, from: { id: 51, first_name: "Z" }, chat: { id: 51 }, date: 1, text: "ambiguous?" },
  };
  const req = new Request("https://w/telegram/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" },
    body: JSON.stringify(update),
  });
  // Stub classify to invoke the dispatcher's send callback the way runClassifier would,
  // by returning a clarify result AFTER the handler builds the dispatcher. Simplest:
  // assert via getPending after a clarify result whose question the handler persists.
  await handleTelegramWebhook(req, env as any, {
    tgFactory: () => fakeTg as any,
    ghFactory: () => ({ getRepoTree: async () => [], getReadme: async () => "", listRecentIssues: async () => [] } as any),
    classify: (async (a: any) => {
      // emulate runClassifier calling the dispatcher's clarifying-question sink
      await a.dispatcher.dispatch({ name: "ask_clarifying_question", input: { question_he: "תוכל להבהיר?", reason_en: "r" } });
      return { kind: "clarify" as const, question_he: "תוכל להבהיר?" };
    }) as any,
  });
  const { getPending } = await import("../../src/lib/kv");
  const pend = await getPending(env as any, 51, /* activeProject default id */ (await (await import("../../src/lib/kv")).getClient(env as any, 51))!.active_project_id);
  expect(pend?.questions_asked).toBe(1);
});
```

> If resolving the active project id in the test is awkward in your fixture setup, simplify: seed a known client/project first (mirror the existing full-handler tests' setup), then read `getPending(env, 51, "<known-project-id>")`. The assertion that matters is `pend?.questions_asked === 1`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- handler-telegram-full`
Expected: FAIL — `pend?.questions_asked` is `undefined` (the callback doesn't write it yet).

- [ ] **Step 3: Update the prompt arg (telegram.ts:182)**

```typescript
    pending_clarification: pending
      ? {
          asked_question_he: pending.asked_question_he,
          original_message: pending.raw_message_text,
          questions_asked: pending.questions_asked ?? 0,
        }
      : null,
```

- [ ] **Step 4: Update dispatcher construction + callback (telegram.ts:239-251)**

In the `sendClarifyingQuestion` callback, add `questions_asked` to the `putPending` payload:

```typescript
  const priorQuestionsAsked = pending?.questions_asked ?? 0;
  const dispatcher = new ToolDispatcher(gh, activeProject.repo, async (q, _reason) => {
    await tg.sendMessage(parsed.chat_id, q);
    await putPending(env, parsed.tg_user_id, activeProject.id, {
      raw_message_id: parsed.message_id,
      raw_message_text: parsed.text,
      attachments,
      asked_question_he: q,
      asked_at: new Date().toISOString(),
      questions_asked: priorQuestionsAsked + 1,
    });
  }, shadowRetrieve, semanticOn ? async (query: string) => {
    const res = await retrieveFn(env, activeProject.repo, query);
    return res.status === "ok" ? res.chunks : [];
  } : undefined, priorQuestionsAsked);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- handler-telegram-full`
Expected: PASS — `pend?.questions_asked === 1`.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/telegram.ts tests/unit/handler-telegram-full.test.ts
git commit -m "feat: thread clarification counter through telegram handler

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Prompt builder — actionable answer-turn instruction

**Files:**
- Modify: `src/prompts/classifier.ts:3-11` (`BuildArgs.pending_clarification` type), `:203-209` (conditional render)
- Test: `tests/unit/prompts-classifier.test.ts`

**Interfaces:**
- Consumes: the `pending_clarification` object now carries `questions_asked: number` (passed by the handler, Task 2 Step 3).
- Produces: system text whose pending block branches on `questions_asked`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/prompts-classifier.test.ts`:

```typescript
it("answer-turn with one prior question allows a gated second question", () => {
  const [, live] = buildClassifierSystem({
    reporter_name: "X", repo: "o/r", repo_context: { tree: "", readme: "", recent_issues: [] },
    raw_message_text: "move it to attendance", attachments_summary: "", prior_conversation: [],
    pending_clarification: { asked_question_he: "?", original_message: "orig", questions_asked: 1 },
  });
  expect(live.text).toMatch(/may ask exactly ONE more/i);
  expect(live.text).not.toMatch(/already asked the client the maximum/i);
});

it("answer-turn at the cap forbids further questions", () => {
  const [, live] = buildClassifierSystem({
    reporter_name: "X", repo: "o/r", repo_context: { tree: "", readme: "", recent_issues: [] },
    raw_message_text: "answer", attachments_summary: "", prior_conversation: [],
    pending_clarification: { asked_question_he: "?", original_message: "orig", questions_asked: 2 },
  });
  expect(live.text).toMatch(/already asked the client the maximum/i);
  expect(live.text).toMatch(/Needs client decision/i);
  expect(live.text).not.toMatch(/may ask exactly ONE more/i);
});
```

> Note: existing tests pass `pending_clarification: { asked_question_he, original_message }` without `questions_asked`. After the type change below they must add `questions_asked: 1` (the existing test at `prompts-classifier.test.ts:88` and `prompts-classifier-history.test.ts:41`). Update those two fixtures to include `questions_asked: 1`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- prompts-classifier`
Expected: the two new tests FAIL (current code emits the static "Do not ask another clarifying question" line regardless of count); existing pending-block tests may also fail to compile until the type/fixtures update.

- [ ] **Step 3: Widen the BuildArgs type (classifier.ts:9)**

```typescript
  pending_clarification: {
    asked_question_he: string;
    original_message: string;
    questions_asked: number;
  } | null;
```

- [ ] **Step 4: Conditional render (classifier.ts:203-209)**

Replace the `if (args.pending_clarification) { ... }` block:

```typescript
  if (args.pending_clarification) {
    const atCap = args.pending_clarification.questions_asked >= 2;
    liveSections.push(
      `\nEarlier you asked the client: "${args.pending_clarification.asked_question_he}"`,
      `Their original message was: "${args.pending_clarification.original_message}"`,
      `The CURRENT MESSAGE above is their answer.`,
      atCap
        ? `You have already asked the client the maximum (2 questions). Do NOT ask again — produce a final classification now. Place any remaining client-only decision under a "## ⚠️ Needs client decision" section in the body, never under developer questions.`
        : `Produce a final classification UNLESS a NEW client-only decision emerged from their answer that passes the clarifying-question gate (client-only AND outcome-changing AND no safe default) — in that case you may ask exactly ONE more focused question. Otherwise do not ask again; write the issue, placing any unresolved client-only decision under "## ⚠️ Needs client decision".`
    );
  }
```

- [ ] **Step 5: Update the two existing fixtures**

In `tests/unit/prompts-classifier.test.ts:88` and `tests/unit/prompts-classifier-history.test.ts:41`, add `questions_asked: 1` to the `pending_clarification` object literal.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- prompts-classifier`
Expected: PASS (new + existing). Then `npm run typecheck` → zero errors (this also clears the Task 2 typecheck dependency).

- [ ] **Step 7: Commit**

```bash
git add src/prompts/classifier.ts tests/unit/prompts-classifier.test.ts tests/unit/prompts-classifier-history.test.ts
git commit -m "feat: actionable count-aware answer-turn clarification instruction

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Prompt — the 3-part gate + tool description

**Files:**
- Modify: `src/prompts/classifier.ts:56-72` (clarifying-question policy)
- Modify: `src/tools/definitions.ts:9` (`ask_clarifying_question` description)
- Test: `tests/unit/prompts-classifier.test.ts`, `tests/unit/tools-definitions.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: prompt + tool description text asserting the gate and the "twice per ticket" budget. No signature changes.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/prompts-classifier.test.ts`:

```typescript
it("states the 3-part client-decision gate in the preamble", () => {
  const [cached] = buildClassifierSystem({
    reporter_name: "X", repo: "o/r", repo_context: { tree: "", readme: "", recent_issues: [] },
    raw_message_text: "x", attachments_summary: "", prior_conversation: [], pending_clarification: null,
  });
  expect(cached.text).toMatch(/client-only/i);
  expect(cached.text).toMatch(/no safe default/i);
  expect(cached.text).toMatch(/at most twice|two questions/i);
});
```

Add to `tests/unit/tools-definitions.test.ts` (find the existing block asserting on `ask_clarifying_question`; add):

```typescript
it("ask_clarifying_question description allows up to two per ticket under the gate", () => {
  const tool = CLASSIFIER_TOOLS.find((t) => t.name === "ask_clarifying_question")!;
  expect(tool.description).toMatch(/at most twice per ticket/i);
  expect(tool.description).not.toMatch(/at most once per ticket/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- prompts-classifier tools-definitions`
Expected: FAIL — current text says "at most once per ticket" and lacks the "no safe default" gate wording.

- [ ] **Step 3: Update the clarifying-question policy (classifier.ts:56-72)**

Insert the gate near the top of the "Clarifying-question policy" section (after line 56's heading). Add this paragraph:

```
- THE GATE — ask the client a clarifying question ONLY when ALL THREE hold:
  1. Client-only: the unresolved point is a decision only the CLIENT can make (a target value, scope, end-state, or business behaviour) — never a technical/developer choice.
  2. Outcome-changing: getting it wrong changes WHAT gets built in a way the client would see, not an internal or cosmetic detail.
  3. No safe default: there is no reasonable default the client could cheaply correct later. (If a safe default exists, pick it and record the assumption — do not ask.)
  If any of the three fails, do NOT ask: write the issue and record the point in the body under the correct section (see "Body sections" below).
- Budget: at most TWICE per ticket, across turns, and only when the gate passes. A new client-only decision that first emerges from the client's answer to your first question is the canonical case for a second question (e.g. they say "move X to screen Y" — does "move" mean relocate, or also keep it on the old screen?). After two questions, never ask again — record any remainder under "## ⚠️ Needs client decision".
```

Then change the existing budget line at `classifier.ts:67` from "Budget: one clarifying question per ticket" to reference the twice-per-ticket rule (or delete it as now-redundant with the line above).

- [ ] **Step 4: Update the tool description (definitions.ts:9)**

Replace the `ask_clarifying_question` `description` string:

```typescript
    description:
      "Pause classification and send a single Hebrew question to the client. Use ONLY when a genuine ambiguity passes the gate: the unresolved point is (1) client-only — a decision only the client can make (target value, scope, end-state, or business behaviour), not a technical choice; (2) outcome-changing — getting it wrong changes what gets built in a client-visible way; and (3) has no safe default the client could cheaply correct later. Do NOT use for politeness, to confirm details clear from context, for chitchat, or for developer/technical decisions (those go in the issue body). You may call this tool at most twice per ticket across turns — typically once on the first message, and once more only if a NEW client-only decision emerges from the client's answer. After this tool is called, do not produce a final classification on this turn; the worker pauses the loop and resumes on the next user message.",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- prompts-classifier tools-definitions`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/classifier.ts src/tools/definitions.ts tests/unit/prompts-classifier.test.ts tests/unit/tools-definitions.test.ts
git commit -m "feat: 3-part client-decision gate in classifier prompt + tool description

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Prompt — taxonomy fix (two body sections + few-shot)

**Files:**
- Modify: `src/prompts/classifier.ts:48` (grounding rule), `:65` (autonomy line), `:144` (Example 4 heading), and `fewShotExamples()` (add Example 7)
- Test: `tests/unit/prompts-classifier.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: prompt text instructing two distinct body sections and demonstrating the boundary by example. No signature changes.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/prompts-classifier.test.ts`:

```typescript
it("teaches the two-section body split and never files client decisions as developer questions", () => {
  const [cached] = buildClassifierSystem({
    reporter_name: "X", repo: "o/r", repo_context: { tree: "", readme: "", recent_issues: [] },
    raw_message_text: "x", attachments_summary: "", prior_conversation: [], pending_clarification: null,
  });
  // Both section headings are documented in the prompt.
  expect(cached.text).toMatch(/## Open questions \(developer decides\)/);
  expect(cached.text).toMatch(/## ⚠️ Needs client decision/);
  // The absence "move = relocate or duplicate" boundary is taught as an example.
  expect(cached.text).toMatch(/relocate|move it to|attendance screen/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- prompts-classifier`
Expected: FAIL — current prompt uses "Open questions (for the developer)" and has no `## ⚠️ Needs client decision` heading.

- [ ] **Step 3: Update the grounding/autonomy rules (classifier.ts:48 and :65)**

At `classifier.ts:48`, change the last sentence of the "Do not invent the client's intent" rule from:

> ...genuinely TECHNICAL implementation choices may be listed in the body under "Open questions (for the developer)"; but anything only the CLIENT can decide ... must be ASKED ...

to:

> ...genuinely TECHNICAL implementation choices may be listed in the body under "## Open questions (developer decides)"; but anything only the CLIENT can decide (the target value, scope, end-state, or business rationale) must be either ASKED via ask_clarifying_question (when the gate passes) or, if the budget is spent or the gate fails, recorded under a SEPARATE "## ⚠️ Needs client decision" section — NEVER mixed into the developer section.

At `classifier.ts:65`, change "record it under 'Open questions (for the developer)'" to "record it under '## Open questions (developer decides)'".

Add a short "Body sections" rule to the "Output language rules" or "Other rules" block:

```
- Body sections for unresolved points — keep them SEPARATE and correctly routed:
  - "## Open questions (developer decides)" — technical/implementation choices only (where a flag lives, data shape, remove-vs-hide as a pure technical matter).
  - "## ⚠️ Needs client decision" — business/product decisions only the client can make that remain unresolved (gate failed, or the 2-question budget is spent). The downstream coding agent routes these back to the client, so a client decision in the wrong section dead-ends at the developer. Never put a client decision under the developer heading.
```

- [ ] **Step 4: Fix Example 4 and add Example 7 in `fewShotExamples()`**

Change Example 4's body heading (`classifier.ts:144`) from `## Open questions (for the developer)` to `## Open questions (developer decides)`.

Add a new example at the end of `fewShotExamples()` (before the closing backtick), built from the real trace:

```
Example 7 — answer turn: a NEW client-only decision emerges → second gated question:
Turn 1 user: "אני רוצה לשנות את איפה שרואים כשמישהו מסמן אי הגעה"
You asked (question 1): "באיזה מסך מדובר, ומה בדיוק לשנות?"
Turn 2 user (their answer): "כרגע המידע מופיע בדשבורד ניהול - אני רוצה שהוא יעבור למסך הנוכחות ושיראה כמו אלו שסימנו הגעה - רק שכתוב אי הגעה והסיבה"
The word "יעבור" (move) is ambiguous — relocate (remove from dashboard) vs. also-show (keep both). That is a CLIENT-only, outcome-changing decision with no safe default → it PASSES the gate, and you have asked only once. Ask the SECOND question:
ask_clarifying_question({ "question_he": "ברור! שאלה אחרונה: שאי-ההגעה תעבור לגמרי ממסך הניהול ותופיע רק במסך הנוכחות, או שתופיע בשני המקומות?", "reason_en": "\\"Move\\" is ambiguous (relocate vs. duplicate); a client-only, outcome-changing decision with no safe default — second question is within the 2-per-ticket budget." })
(If you had ALREADY asked twice, you would instead write the issue with this under "## ⚠️ Needs client decision: relocate vs. duplicate on the dashboard".)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- prompts-classifier`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/classifier.ts tests/unit/prompts-classifier.test.ts
git commit -m "feat: split issue-body open questions into developer vs client-decision sections

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full suite + typecheck gate

**Files:** none (verification task).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (was 533; new tests added in Tasks 1–5 increase the count). If any pre-existing pending-block test fails, confirm its fixture got `questions_asked` (Task 3 Step 5).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit (only if any fixup was needed)**

```bash
git add -A
git commit -m "test: fixups for clarification-cap suite

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-implementation (manual, not in this plan)

- **Live validation before trusting** (per CLAUDE.md Opus-tuning caveats): replay the absence trace on the live worker — send the two Hebrew messages and confirm the second turn now asks the relocate-vs-duplicate question instead of writing it into the body. Use `wrangler tail` first, then trigger.
- **Deploy:** `npx wrangler deploy`.
- **Existing absence issue:** ask the client the one surviving question manually and update the issue body. No migration.

## Self-Review

**Spec coverage:**
- Spec §1 (counter) → Task 1 (type) + Task 2 (write) + Task 3 (read into prompt). ✓
- Spec §2 (dispatcher cap) → Task 1. ✓
- Spec §3 (answer-turn instruction) → Task 3. ✓
- Spec §4 (gate + tool desc) → Task 4. ✓
- Spec §5 (taxonomy/two sections + few-shot) → Task 5. ✓
- Spec §6 (handler wiring) → Task 2. ✓
- Spec testing section → Tasks 1–5 tests + Task 6 full-suite gate. ✓

**Placeholder scan:** No TBD/TODO; every code step shows code. The only soft spot is Task 2 Step 1's active-project-id resolution, which includes an explicit fallback instruction (seed a known project, assert `questions_asked === 1`).

**Type consistency:** `questions_asked?: number` (type) read as `?? 0` everywhere; `priorQuestionsAsked` is the 8th `ToolDispatcher` param consistently in Task 1 (definition) and Task 2 (call site); `MAX_TICKET_CLARIFICATIONS` named identically in dispatcher and referenced in Task 1 tests; body headings `## Open questions (developer decides)` and `## ⚠️ Needs client decision` spelled identically across Tasks 3, 4, 5.

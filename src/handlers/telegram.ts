import type { Env } from "../types";
import { verifyTelegramSecret, TelegramClient, safeSend, escapeHtml } from "../lib/telegram";
import { parseTelegramUpdate } from "../lib/telegram-update";
import { resolveIdentity } from "../pipeline/identity";
import { checkAndIncrementMsgRate, recordSpend, estimateClassifierCostCents } from "../pipeline/rate-limit";
import { findRecentActivity, recordActivity } from "../pipeline/recency";
import { processAttachments } from "../pipeline/media";
import { fetchCodebaseContext } from "../pipeline/codebase-context";
import { ensureFreshIndex, retrieveCode } from "../pipeline/code-index";
import { continueIndexBuild } from "./index-step";
import { runClassifier } from "../pipeline/classifier";
import { writeIssueOrComment } from "../pipeline/issue-writer";
import { notifyClient, notifyClientWithProject, notifyIdo } from "../pipeline/notifier";
import { ClaudeClient, transcribeWithGemini } from "../lib/ai";
import { GcsClient } from "../lib/gcs";
import { GitHubClient } from "../lib/github";
import { ToolDispatcher, isLowGrounding } from "../tools/dispatch";
import { CLASSIFIER_TOOLS } from "../tools/definitions";
import { buildClassifierSystem } from "../prompts/classifier";
import { getPending, putPending, deletePending, putIssueChat, getActiveProject, getClient, putClient, getHistory, appendTurn, recordClassification } from "../lib/kv";
import type { ParsedCallbackQuery, ParsedTelegramMessage } from "../lib/telegram-update";
import type { ClientRecord, RetrievedChunk, ClassificationRecord } from "../types";
import { buildPickerKeyboard } from "../lib/picker";
import { handleAdminCommand } from "./admin";

// Test-only injection points; production calls pass undefined.
export interface TelegramHandlerDeps {
  tgFactory?: (env: Env) => TelegramClient;
  classify?: typeof runClassifier;
  writeIssue?: typeof writeIssueOrComment;
  ghFactory?: (env: Env, repo: string) => GitHubClient;
  retrieve?: typeof retrieveCode;
}

export async function handleTelegramWebhook(req: Request, env: Env, deps: TelegramHandlerDeps = {}, ctx?: ExecutionContext): Promise<Response> {
  if (!verifyTelegramSecret(req, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const update = await req.json().catch(() => null);
  const parsed = parseTelegramUpdate(update);
  if (!parsed) return Response.json({ action: "ignored_unsupported_update" });

  const tg = deps.tgFactory ? deps.tgFactory(env) : new TelegramClient(env.TELEGRAM_BOT_TOKEN);

  if (parsed.kind === "unsupported") {
    const reply = unsupportedTypeMessage(parsed.unsupported_type);
    await safeSend(tg, parsed.chat_id, reply, "client_unsupported_type");
    return Response.json({ action: "ignored_unsupported_type", type: parsed.unsupported_type });
  }

  // Callback queries (inline-keyboard button taps) are handled before the
  // admin / identity / rate-limit pipeline — they are fire-and-forget acks.
  if (parsed.kind === "callback_query") {
    return handleCallbackQuery(env, tg, parsed);
  }

  const inboxChatId = Number(env.IDO_INBOX_CHAT_ID);

  // Built-in client commands (handled before identity gate so /start works
  // for first-contact users who haven't been registered yet).
  if (parsed.text === "/start" || parsed.text.startsWith("/start ")) {
    return handleStart(env, tg, parsed);
  }
  if (parsed.text === "/help" || parsed.text.startsWith("/help ")) {
    return handleHelp(env, tg, parsed);
  }

  // Admin commands bypass identity/rate-limit gates. A newly attached repo gets a
  // proactive (best-effort) index build kicked off the response path; cron + lazy
  // ingest are the fallbacks if it's dropped.
  const adminHandled = await handleAdminCommand(env, tg, {
    tg_user_id: parsed.tg_user_id, chat_id: parsed.chat_id, text: parsed.text,
  }, {
    kickoffIndexBuild: (repo: string) => {
      if (ctx) ctx.waitUntil(continueIndexBuild(req, env, repo, 0));
    },
  });
  if (adminHandled) return Response.json({ action: "admin" });

  const id = await resolveIdentity(env, parsed.tg_user_id);
  if (id.kind === "unknown") {
    await safeSend(tg, parsed.chat_id, "מצטער, הבוט הזה למעט לקוחות רשומים בלבד. אנא פנה לאידו ישירות.", "client_unknown_sender");
    return Response.json({ action: "rejected_unknown_sender" });
  }
  if (id.kind === "inactive") {
    return Response.json({ action: "rejected_inactive_client" });
  }

  if (parsed.text.startsWith("/use") || parsed.text === "/projects") {
    return handleClientCommand(env, tg, parsed, id.record);
  }

  // Resolve which of the client's repos this message routes to. Multi-project
  // clients can switch via /use; the active_project_id field tracks that.
  const activeProject = getActiveProject(id.record);

  const rate = await checkAndIncrementMsgRate(env, parsed.tg_user_id);
  if (!rate.allowed) {
    await safeSend(tg, parsed.chat_id, "חרגת מהמכסה השעתית, נסה שוב מאוחר יותר.", "client_rate_limited");
    await notifyIdo(tg, inboxChatId, {
      action: "rate_limited", reporter_name: id.record.name, repo: activeProject.repo, message: rate.reason,
      project_name_he: activeProject.name_he,
    });
    return Response.json({ action: "rate_limited", reason: rate.reason });
  }

  await tg.react(parsed.chat_id, parsed.message_id, "👀").catch(() => {});
  await safeSend(tg, parsed.chat_id, "מעבד את ההודעה... 🔍", "client_processing");

  // Build downstream clients. The GitHub App installation token is fetched per
  // request and cached in KV (~50 min TTL). If the App isn't installed on this
  // client's repo, getInstallationToken throws with a "Install the App" hint.
  let gh: GitHubClient;
  if (deps.ghFactory) {
    gh = deps.ghFactory(env, activeProject.repo);
  } else {
    try {
      gh = await GitHubClient.forRepo(env, activeProject.repo);
    } catch (e) {
      await safeSend(tg, parsed.chat_id,
        `⚠️ ${activeProject.name_he ?? activeProject.repo}: עדיין לא הותקנה הגישה ל-GitHub. אידו יקבל הודעה ויטפל. נסה/י שוב בקרוב 🙏`,
        "client_app_not_installed",
      );
      await notifyIdo(tg, inboxChatId, {
        action: "error", reporter_name: id.record.name, repo: activeProject.repo,
        message: `App not installed: ${(e as Error).message}`,
        project_name_he: activeProject.name_he,
      });
      return Response.json({ action: "error_app_not_installed", repo: activeProject.repo });
    }
  }
  const claude = ClaudeClient.fromApiKey(env.ANTHROPIC_API_KEY);
  const gcs = new GcsClient(env.GCS_SERVICE_ACCOUNT_JSON, env.GCS_BUCKET);

  // Process media first so the classifier sees transcriptions.
  const mediaResult = await processAttachments(parsed.attachments, {
    tg: { getFilePath: tg.getFilePath.bind(tg), downloadFile: tg.downloadFile.bind(tg) },
    gcs,
    transcribeAudio: (audio, mime) => transcribeWithGemini(audio, mime, env.GEMINI_API_KEY),
  });
  const attachments = mediaResult.attachments;
  const mediaErrors = mediaResult.errors;
  if (mediaErrors.length > 0) {
    console.warn("media_processing_errors", {
      repo: activeProject.repo,
      errors: mediaErrors.map((e) => ({ kind: e.kind, stage: e.stage, message: e.message })),
    });
  }

  // 60s recency window: if user has an in-flight issue on the same repo, append.
  const recent = await findRecentActivity(env, parsed.tg_user_id, activeProject.id);
  if (recent && recent.repo === activeProject.repo) {
    const followUpBody = `${parsed.text}\n\n${attachments.map((a) => a.signed_url ? `- [media](${a.signed_url})` : `- (${a.kind})`).join("\n")}`;
    await gh.createComment(recent.repo, recent.issue_number, followUpBody);
    await recordActivity(env, parsed.tg_user_id, activeProject.id, { ...recent, last_message_at: new Date().toISOString() });
    await notifyIdo(tg, inboxChatId, {
      action: "comment", reporter_name: id.record.name, repo: recent.repo, issue_number: recent.issue_number, issue_url: recent.issue_url,
      project_name_he: activeProject.name_he,
    });
    return Response.json({ action: "appended_to_recent_issue", number: recent.issue_number });
  }

  // Append the user turn to conversation history (best-effort; failures logged but non-blocking).
  await appendTurn(env, parsed.tg_user_id, activeProject.id, { role: "user", text: parsed.text }).catch((e) => {
    console.warn("history_append_failed", { stage: "user", error: (e as Error).message });
  });

  const history = await getHistory(env, parsed.tg_user_id, activeProject.id);
  const priorTurns = history?.turns ?? [];
  // The user turn we just appended is the most recent — strip it so the classifier sees PRIOR turns only.
  const prior_conversation = priorTurns.slice(0, -1);

  const pending = await getPending(env, parsed.tg_user_id, activeProject.id);
  const repoCtx = await fetchCodebaseContext(env, activeProject.repo, gh);

  const system = buildClassifierSystem({
    reporter_name: id.record.name,
    repo: activeProject.repo,
    repo_context: repoCtx,
    raw_message_text: parsed.text,
    attachments_summary: attachments.map((a) => a.kind).join(", "),
    pending_clarification: pending
      ? {
          asked_question_he: pending.asked_question_he,
          original_message: pending.raw_message_text,
          // A pending record implies ≥1 question already asked; legacy records
          // lack the field, so default to 1 (not 0) to keep the cap accurate.
          questions_asked: pending.questions_asked ?? 1,
        }
      : null,
    prior_conversation,
  });

  // Semantic code retrieval is a per-project, default-on feature: warm the index
  // (off the response path) and inject semantic matches into github_search_code
  // for any project that hasn't opted out via semantic_enabled=false. Shadow-mode
  // clients additionally capture what retrieval WOULD return for the shadow trace.
  // Each shadow promise resolves to a shadow hit (never rejects — failures resolve
  // to a status string), so the trace can await them all without a parallel result
  // array.
  const retrieveFn = deps.retrieve ?? retrieveCode;
  const semanticOn = activeProject.semantic_enabled !== false;
  const shadowHits: Promise<ShadowHit>[] = [];
  let shadowRetrieve: ((query: string) => void) | undefined;
  if (semanticOn) {
    const build = ensureFreshIndex(env, activeProject.repo, gh)
      .then(async (r) => {
        if (r.built) {
          console.log("code_index_build_progress", {
            repo: activeProject.repo,
            indexed: r.indexed_files,
            total: r.total_files,
            complete: r.complete,
            chunks: r.chunk_count,
          });
        }
        // Self-continue the build across invocations until the repo is fully
        // indexed, so one message indexes the whole repo instead of ~20.
        // Awaited INLINE here (NOT a nested ctx.waitUntil, which is invalid once
        // the response has already returned) so the whole chain stays alive under
        // the single outer waitUntil below.
        if (r.built && !r.complete) {
          await continueIndexBuild(req, env, activeProject.repo, 1);
        }
      })
      .catch((e) => {
        console.warn("code_index_build_failed", { repo: activeProject.repo, error: (e as Error).message });
      });
    if (ctx) ctx.waitUntil(build as Promise<unknown>);
    // The shadow trace is the only consumer of shadowHits, and the active
    // retrieval below already embeds each query for semantic-on clients — so only
    // fire this extra retrieval for shadow_mode clients to avoid doubling the
    // per-query embedding cost against the Workers AI neuron budget.
    if (id.record.shadow_mode) {
      shadowRetrieve = (query: string) => {
        const p: Promise<ShadowHit> = retrieveFn(env, activeProject.repo, query)
          .then((r) => (r.status === "ok" ? { query, status: "ok", chunks: r.chunks } : { query, status: r.status }))
          .catch((e) => ({ query, status: `error: ${(e as Error).message}` }));
        shadowHits.push(p);
        if (ctx) ctx.waitUntil(p);
      };
    }
  }

  // A pending record exists ONLY because a clarifying question was already sent,
  // so a record missing the (newly added, optional) questions_asked field — a
  // legacy record written before this deploy — means at least one was asked.
  // Default to 1, not 0, or the cross-turn cap under-counts during rollout and
  // could let a 3rd question through.
  const priorQuestionsAsked = pending ? (pending.questions_asked ?? 1) : 0;
  const dispatcher = new ToolDispatcher(gh, activeProject.repo, async (q, _reason) => {
    await tg.sendMessage(parsed.chat_id, q);
    await putPending(env, parsed.tg_user_id, activeProject.id, {
      // Preserve the ORIGINAL request's context when re-asking on a later turn:
      // overwriting with parsed.text would make the stored "original_message"
      // the client's answer to the previous question, not their true request.
      raw_message_id: pending?.raw_message_id ?? parsed.message_id,
      raw_message_text: pending?.raw_message_text ?? parsed.text,
      attachments: pending?.attachments ?? attachments,
      asked_question_he: q,
      asked_at: new Date().toISOString(),
      questions_asked: priorQuestionsAsked + 1,
    });
  }, shadowRetrieve, semanticOn ? async (query: string) => {
    const res = await retrieveFn(env, activeProject.repo, query);
    return res.status === "ok" ? res.chunks : [];
  } : undefined, priorQuestionsAsked);

  const classifyImpl = deps.classify ?? runClassifier;
  const transcript = attachments.find((a) => a.transcription)?.transcription;
  // Anthropic rejects empty text content blocks with HTTP 400. The parser guarantees
  // that an empty parsed.text only reaches here alongside attachments, so synthesize
  // a stand-in describing what the client sent.
  const attachmentKinds = attachments.map((a) => a.kind).join(", ");
  const baseText = parsed.text || `(no caption — client sent: ${attachmentKinds})`;
  const result = await classifyImpl({
    claude, dispatcher,
    systemBlocks: system,
    userText: baseText + (transcript ? `\n\nVoice transcription:\n${transcript}` : ""),
    tools: CLASSIFIER_TOOLS,
  });

  // Spend accounting from the run's actual Opus 4.8 token usage (final turns
  // carry usage; clarify/error turns don't surface it, so fall back to a nominal
  // 1¢ so they still count toward the soft daily cap).
  const spendCents = result.kind === "final" ? estimateClassifierCostCents(result.usage) : 1;
  await recordSpend(env, parsed.tg_user_id, spendCents);

  // Durable per-classification outcome record + grounding signal. The grounding
  // is observed across the dispatcher's github_search_code calls; low_grounding
  // flags the documented failure mode (code search empty + weak semantic match).
  // persist() merges branch-specific fields and writes best-effort (no-op when
  // the CLASSIFICATIONS namespace isn't provisioned).
  const grounding = dispatcher.getGrounding();
  const lowGrounding = isLowGrounding(grounding);
  const usage = result.kind === "final" ? result.usage : { input_tokens: 0, output_tokens: 0 };
  const persistClassification = async (extra: Partial<ClassificationRecord> = {}): Promise<void> => {
    await recordClassification(env, {
      ts: new Date().toISOString(),
      tg_user_id: parsed.tg_user_id,
      reporter_name: id.record.name,
      repo: activeProject.repo,
      project_id: activeProject.id,
      user_text: parsed.text,
      result_kind: result.kind,
      github_search_calls: grounding.github_search_calls,
      github_total_matches: grounding.github_total_matches,
      semantic_calls: grounding.semantic_calls,
      top_semantic_score: grounding.top_semantic_score,
      low_grounding: lowGrounding,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost_cents: spendCents,
      ...extra,
    });
  };

  if (id.record.shadow_mode && result.kind === "final") {
    // Wait for any in-flight shadow retrievals so the comparison is captured.
    // All dynamic values (file paths with underscores/slashes, user text, JSON)
    // are HTML-escaped — HTML parse mode is far more robust than legacy Markdown.
    const retrievalBlock = formatShadowRetrievals(await Promise.all(shadowHits));
    await safeSend(
      tg,
      inboxChatId,
      `🪞 <b>Shadow</b> — ${escapeHtml(id.record.name)}\n\n<b>Raw:</b> ${escapeHtml(parsed.text)}\n\n<b>Output:</b>\n<pre>${escapeHtml(JSON.stringify(result.output, null, 2))}</pre>${retrievalBlock}`,
      "shadow_mode_trace",
      { parseMode: "HTML" },
    );
  }

  if (result.kind === "clarify") {
    await appendTurn(env, parsed.tg_user_id, activeProject.id, { role: "assistant", text: result.question_he }).catch((e) => {
      console.warn("history_append_failed", { stage: "clarify", error: (e as Error).message });
    });
    await persistClassification();
    return Response.json({ action: "asked_clarifying_question", question_he: result.question_he });
  }
  if (result.kind === "error") {
    await safeSend(
      tg, parsed.chat_id,
      "מצטער, משהו השתבש בעיבוד ההודעה. אידו יבדוק. נסה/י שוב בעוד דקה 🙏",
      "client_classifier_error",
    );
    await notifyIdo(tg, inboxChatId, {
      action: "error", reporter_name: id.record.name, repo: activeProject.repo, message: result.message,
      project_name_he: activeProject.name_he,
    });
    await persistClassification();
    return Response.json({ action: "classifier_error", message: result.message });
  }

  if (pending) await deletePending(env, parsed.tg_user_id, activeProject.id);

  // out_of_scope short-circuit: no GitHub write, but still acknowledge to the client and notify Ido.
  if (result.output.type === "out_of_scope") {
    await notifyClientWithProject(tg, parsed.chat_id, result.output.client_reply_he, {
      project_count: id.record.projects.length,
      project_name_he: activeProject.name_he,
    });
    await appendTurn(env, parsed.tg_user_id, activeProject.id, { role: "assistant", text: result.output.client_reply_he }).catch((e) => {
      console.warn("history_append_failed", { stage: "out_of_scope", error: (e as Error).message });
    });
    await notifyIdo(tg, inboxChatId, {
      action: "out_of_scope", reporter_name: id.record.name, repo: activeProject.repo,
      message: result.output.client_reply_he,
      project_name_he: activeProject.name_he,
    });
    await persistClassification({ type: result.output.type, should_create_issue: false });
    return Response.json({ action: "out_of_scope" });
  }

  // Normal final path — write to GitHub FIRST so a write failure throws before we
  // mislead the client with a success-implying reply.
  const writeImpl = deps.writeIssue ?? writeIssueOrComment;
  const written = await writeImpl(gh, activeProject.repo, result.output, {
    reporter_name: id.record.name, attachments, message_id: parsed.message_id, media_errors: mediaErrors,
  });

  await notifyClientWithProject(tg, parsed.chat_id, result.output.client_reply_he, {
    project_count: id.record.projects.length,
    project_name_he: activeProject.name_he,
  });
  await appendTurn(env, parsed.tg_user_id, activeProject.id, { role: "assistant", text: result.output.client_reply_he }).catch((e) => {
    console.warn("history_append_failed", { stage: "final", error: (e as Error).message });
  });

  if (written.kind === "created") {
    await putIssueChat(env, activeProject.repo, written.number, {
      tg_user_id: parsed.tg_user_id, telegram_chat_id: parsed.chat_id,
    });
    await recordActivity(env, parsed.tg_user_id, activeProject.id, {
      issue_url: written.url, repo: activeProject.repo, issue_number: written.number,
      last_message_at: new Date().toISOString(),
    });
    await notifyIdo(tg, inboxChatId, {
      action: "created", reporter_name: id.record.name, repo: activeProject.repo,
      issue_number: written.number, issue_url: written.url,
      type: result.output.type, severity: result.output.severity, sensitive: result.output.sensitive,
      project_name_he: activeProject.name_he,
      low_grounding: lowGrounding,
      ...(mediaErrors.length > 0 ? { media_errors: mediaErrors } : {}),
    });
    await persistClassification({
      type: result.output.type, severity: result.output.severity,
      should_create_issue: result.output.should_create_issue,
      is_followup_to_issue: result.output.is_followup_to_issue,
      issue_number: written.number,
    });
    return Response.json({ action: "created", number: written.number });
  }
  if (written.kind === "comment") {
    await notifyIdo(tg, inboxChatId, {
      action: "comment", reporter_name: id.record.name, repo: activeProject.repo,
      issue_number: written.number, issue_url: `https://github.com/${activeProject.repo}/issues/${written.number}`,
      project_name_he: activeProject.name_he,
      ...(mediaErrors.length > 0 ? { media_errors: mediaErrors } : {}),
    });
    await persistClassification({
      type: result.output.type, severity: result.output.severity,
      should_create_issue: result.output.should_create_issue,
      is_followup_to_issue: result.output.is_followup_to_issue,
      issue_number: written.number,
    });
    return Response.json({ action: "comment", number: written.number });
  }
  await notifyIdo(tg, inboxChatId, {
    action: "skipped", reporter_name: id.record.name, repo: activeProject.repo,
    project_name_he: activeProject.name_he,
  });
  await persistClassification({
    type: result.output.type, severity: result.output.severity,
    should_create_issue: result.output.should_create_issue,
  });
  return Response.json({ action: "skipped" });
}

// One semantic-retrieval shadow comparison: the github_search_code query and
// what semantic retrieval returned for it (or a status string on miss/error).
interface ShadowHit {
  query: string;
  status: string;
  chunks?: RetrievedChunk[];
}

// Renders the semantic-retrieval shadow comparison for the Ido digest. Returns
// "" when nothing was retrieved (no github_search_code calls this ticket). The
// whole block is a fenced code segment so paths with underscores can't break
// Telegram's Markdown parser.
function formatShadowRetrievals(retrievals: ShadowHit[]): string {
  if (retrievals.length === 0) return "";
  const lines: string[] = [];
  for (const r of retrievals) {
    lines.push(`query: ${r.query}`);
    if (r.status !== "ok") {
      lines.push(`  → ${r.status}`);
      continue;
    }
    if (!r.chunks || r.chunks.length === 0) {
      lines.push("  → (no matches)");
      continue;
    }
    for (const c of r.chunks) {
      lines.push(`  → ${c.path}:${c.start_line}-${c.end_line} (score ${c.score.toFixed(3)})`);
    }
  }
  return `\n\n<b>Semantic retrieval (shadow):</b>\n<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

async function handleStart(env: Env, tg: TelegramClient, parsed: ParsedTelegramMessage): Promise<Response> {
  const client = await getClient(env, parsed.tg_user_id);
  if (!client) {
    await safeSend(
      tg, parsed.chat_id,
      "שלום! הבוט הזה מיועד ללקוחות רשומים בלבד. אנא פנה לאידו ישירות כדי להירשם.",
      "client_start_unregistered",
    );
    return Response.json({ action: "start_unregistered" });
  }
  if (!client.active) {
    return Response.json({ action: "start_inactive" });
  }
  const projectLine = client.projects.length > 1
    ? `\n\nהפרויקטים שלך: ${client.projects.map((p) => p.name_he).join(", ")}.\n/use להחליף פרויקט פעיל.`
    : "";
  const text =
    `שלום ${client.name}! אני בוט פיידבק — תפקידי לתעד דיווחי באגים, בקשות פיצ'ר ושאלות עבור אידו.\n\n` +
    `מה אני יכול:\n` +
    `• לתעד דיווחים שלך כטיקט עם תיאור מובנה.\n` +
    `• לבקש הבהרה אם משהו לא ברור.\n` +
    `• לקבל תמונות והקלטות קול.\n` +
    `• להציע קישור לטיקטים שכבר קיימים אם הדיווח שלך דומה.\n\n` +
    `מה אני לא יכול:\n` +
    `• לשלוח לך תוכן של קבצים, README, או קוד.\n` +
    `• לפתוח דפים או קישורים בשבילך.\n` +
    `• לבצע פעולות (כמו סגירת טיקט) — רק לתעד.` +
    projectLine + `\n/help לעזרה.`;
  await safeSend(tg, parsed.chat_id, text, "client_start_registered");
  return Response.json({ action: "start_registered" });
}

async function handleHelp(env: Env, tg: TelegramClient, parsed: ParsedTelegramMessage): Promise<Response> {
  const client = await getClient(env, parsed.tg_user_id);
  if (!client) {
    await safeSend(
      tg, parsed.chat_id,
      "הבוט הזה מיועד ללקוחות רשומים בלבד. אנא פנה לאידו ישירות.",
      "client_help_unregistered",
    );
    return Response.json({ action: "help_unregistered" });
  }
  const lines = [
    "מה אני יכול:",
    "• שלח/י הודעה רגילה — אני אקטלג כבאג, פיצ'ר או שאלה ואפתח טיקט.",
    "• אפשר לצרף תמונה או הקלטת קול.",
    "• אם השאלה לא ברורה, אני אבקש הבהרה.",
    "",
    "מה אני לא יכול:",
    "• לשלוח תוכן קבצים, README, קישורים פתוחים, או קוד.",
    "• לבצע פעולות מחוץ לתיעוד.",
  ];
  if (client.projects.length > 1) {
    lines.push("");
    lines.push("• /use <שם> — להחליף פרויקט פעיל.");
    lines.push("• /projects — להציג את הפרויקטים שלך.");
  }
  lines.push("");
  lines.push("• /help — להציג את ההודעה הזו.");
  await safeSend(tg, parsed.chat_id, lines.join("\n"), "client_help_registered");
  return Response.json({ action: "help_registered" });
}

async function handleClientCommand(
  env: Env, tg: TelegramClient, parsed: ParsedTelegramMessage, client: ClientRecord,
): Promise<Response> {
  if (client.projects.length <= 1) {
    await tg.sendMessage(parsed.chat_id, `יש לך פרויקט אחד: ${client.projects[0]!.name_he}.`);
    return Response.json({ action: "single_project_no_op" });
  }

  const tokens = parsed.text.trim().split(/\s+/);
  if (parsed.text === "/projects" || tokens.length === 1) {
    await tg.sendMessageWithKeyboard(
      parsed.chat_id,
      "בחר/י פרויקט פעיל:",
      buildPickerKeyboard(client),
    );
    return Response.json({ action: "shown_picker" });
  }

  const targetId = tokens[1]!;
  const target = client.projects.find((p) => p.id === targetId);
  if (!target) {
    await tg.sendMessage(
      parsed.chat_id,
      `פרויקט "${targetId}" לא נמצא. הפרויקטים שלך: ${client.projects.map((p) => p.id).join(", ")}.`,
    );
    return Response.json({ action: "use_unknown_project" });
  }

  // Cancel pending classification on the old project if switching.
  let cancelledPending = false;
  if (targetId !== client.active_project_id) {
    const oldProject = client.projects.find((p) => p.id === client.active_project_id);
    const oldProjectName = oldProject?.name_he ?? client.active_project_id;
    const pending = await getPending(env, parsed.tg_user_id, client.active_project_id);
    if (pending) {
      await deletePending(env, parsed.tg_user_id, client.active_project_id);
      cancelledPending = true;
    }
    await putClient(env, parsed.tg_user_id, { ...client, active_project_id: targetId });
    await tg.sendMessage(parsed.chat_id, `→ עברת ל${target.name_he}`);
    if (cancelledPending) {
      await tg.sendMessage(
        parsed.chat_id,
        `ביטלתי את השאלה ששאלתי לגבי ${oldProjectName}. שלח/י את ההודעה מחדש בהקשר של ${target.name_he} אם רלוונטי.`,
      );
    }
  } else {
    // No switch needed, just confirm current project.
    await tg.sendMessage(parsed.chat_id, `→ עברת ל${target.name_he}`);
  }

  return Response.json({ action: "project_switched_via_use" });
}

async function handleCallbackQuery(env: Env, tg: TelegramClient, cb: ParsedCallbackQuery): Promise<Response> {
  const client = await getClient(env, cb.tg_user_id);
  if (!client || !client.active) {
    // Don't ack a non-client; they shouldn't get feedback.
    return Response.json({ action: "rejected_unknown_sender" });
  }

  if (cb.data === "use:_cancel") {
    await tg.editMessageReplyMarkup(cb.chat_id, cb.message_id);
    await tg.answerCallbackQuery(cb.callback_query_id, { text: "בוטל" });
    return Response.json({ action: "picker_cancelled" });
  }

  if (!cb.data.startsWith("use:")) {
    await tg.answerCallbackQuery(cb.callback_query_id);
    return Response.json({ action: "ignored_unknown_callback" });
  }

  const targetId = cb.data.slice("use:".length);
  const target = client.projects.find((p) => p.id === targetId);
  if (!target) {
    await tg.answerCallbackQuery(cb.callback_query_id, { text: "פרויקט זה אינו זמין יותר", show_alert: true });
    return Response.json({ action: "rejected_stale_callback" });
  }

  let cancelledPending = false;
  let oldProjectName = "";
  if (client.active_project_id !== targetId) {
    const oldProject = client.projects.find((p) => p.id === client.active_project_id);
    oldProjectName = oldProject?.name_he ?? client.active_project_id;
    const pending = await getPending(env, cb.tg_user_id, client.active_project_id);
    if (pending) {
      await deletePending(env, cb.tg_user_id, client.active_project_id);
      cancelledPending = true;
    }
    await putClient(env, cb.tg_user_id, { ...client, active_project_id: targetId });
  }
  await tg.editMessageReplyMarkup(cb.chat_id, cb.message_id);
  await tg.answerCallbackQuery(cb.callback_query_id, { text: `→ עברת ל${target.name_he}` });
  if (cancelledPending) {
    await tg.sendMessage(
      cb.chat_id,
      `ביטלתי את השאלה ששאלתי לגבי ${oldProjectName}. שלח/י את ההודעה מחדש בהקשר של ${target.name_he} אם רלוונטי.`,
    );
  }
  return Response.json({ action: "project_switched", project_id: targetId });
}

function unsupportedTypeMessage(type: "sticker" | "video_note" | "location" | "poll" | "contact" | "animation"): string {
  const typeNames: Record<typeof type, string> = {
    sticker: "מדבקה",
    video_note: "סרטון מעגלי",
    location: "מיקום",
    poll: "סקר",
    contact: "איש קשר",
    animation: "GIF",
  };
  return `קיבלתי ${typeNames[type]}, אבל אני לא יכול לטפל בסוג הזה. נסה/י לשלוח טקסט, תמונה, סרטון רגיל או הקלטת קול 🙏`;
}

import type { TelegramClient } from "../lib/telegram";
import { safeSend, escapeHtml } from "../lib/telegram";
import type { MediaError } from "./media";

export interface IdoNotification {
  action: "created" | "comment" | "skipped" | "rate_limited" | "error" | "out_of_scope";
  reporter_name: string;
  repo: string;
  issue_number?: number;
  issue_url?: string;
  type?: string;
  severity?: string;
  sensitive?: boolean;
  message?: string;
  project_name_he?: string;
  media_errors?: MediaError[];
}

export async function notifyClient(tg: TelegramClient, chatId: number, text: string): Promise<void> {
  await safeSend(tg, chatId, text, "client_reply");
}

export async function notifyClientWithProject(
  tg: TelegramClient, chatId: number, body: string,
  ctx: { project_count: number; project_name_he: string },
): Promise<void> {
  const text = ctx.project_count > 1 ? `→ ${ctx.project_name_he}\n─────\n${body}` : body;
  await safeSend(tg, chatId, text, "client_reply_with_project");
}

export async function notifyIdo(
  tg: TelegramClient,
  inboxChatId: number,
  n: IdoNotification
): Promise<void> {
  const lock = n.sensitive ? "🔒 " : "";
  const repo = escapeHtml(n.repo);
  const name = escapeHtml(n.reporter_name);
  const lines: string[] = [];
  switch (n.action) {
    case "created":
      lines.push(`${lock}📩 <b>New issue</b> — ${name} (${repo})`);
      lines.push(`${escapeHtml(n.type ?? "?")} · ${escapeHtml(n.severity ?? "?")} · <a href="${escapeHtml(n.issue_url ?? "")}">${repo}#${escapeHtml(String(n.issue_number ?? ""))}</a>`);
      break;
    case "comment":
      lines.push(`${lock}💬 <b>Follow-up</b> — ${name} (${repo})`);
      lines.push(`Updated <a href="${escapeHtml(n.issue_url ?? "")}">${repo}#${escapeHtml(String(n.issue_number ?? ""))}</a>`);
      break;
    case "skipped":
      lines.push(`💭 Chitchat from ${name} — no issue created.`);
      break;
    case "rate_limited":
      lines.push(`⚠️ ${name} hit a rate limit: ${escapeHtml(n.message ?? "")}`);
      break;
    case "error":
      lines.push(`❌ Classifier error for ${name} (${repo}): ${escapeHtml(n.message ?? "(no detail)")}`);
      break;
    case "out_of_scope":
      lines.push(`🚫 <b>Out-of-scope</b> from ${name} (${repo}): ${escapeHtml((n.message ?? "").slice(0, 200))}`);
      break;
  }
  if (n.project_name_he) lines.push(`Project: ${escapeHtml(n.project_name_he)}`);
  if (n.media_errors && n.media_errors.length > 0) {
    const summary = n.media_errors.map((e) => `${e.kind} ${e.stage}`).join(", ");
    lines.push(`⚠️ Media errors: ${escapeHtml(summary)}`);
  }
  await safeSend(tg, inboxChatId, lines.join("\n"), `ido_${n.action}`, { parseMode: "HTML" });
}

import type { GitHubClient } from "../lib/github";
import type { ClassifierOutput, AttachmentRef } from "../types";
import type { MediaError } from "./media";

export interface WriteContext {
  reporter_name: string;
  attachments: AttachmentRef[];
  message_id: number;
  media_errors?: MediaError[];
}

export type WriteResult =
  | { kind: "created"; number: number; url: string }
  | { kind: "comment"; number: number }
  | { kind: "skipped" };

function attachmentsBlock(att: AttachmentRef[]): string {
  if (att.length === 0) return "";
  const lines = att.map((a) => {
    if (a.kind === "photo" && a.signed_url) return `- ![Screenshot](${a.signed_url})`;
    if (a.kind === "voice") {
      const tx = a.transcription ? `\n  > ${a.transcription}` : "";
      const link = a.signed_url ? `[Original recording](${a.signed_url})` : "(recording not stored)";
      return `- 🎙️ ${link}${tx}`;
    }
    if (a.kind === "video" && a.signed_url) return `- 🎬 [Video](${a.signed_url})`;
    return `- (file: ${a.kind})`;
  });
  return "\n\n**Media:**\n" + lines.join("\n");
}

function mediaErrorsBlock(errs?: MediaError[]): string {
  if (!errs || errs.length === 0) return "";
  const summary = errs.map((e) => `${e.kind}/${e.stage}`).join(", ");
  return `\n\n⚠️ _Media handling: ${errs.length} attachment(s) failed (${summary}). Original media may be missing from this issue._`;
}

function metadataFooter(ctx: WriteContext): string {
  return `\n\n---\nSource: Telegram | Reporter: ${ctx.reporter_name} | Reported: ${new Date().toISOString()}\nOriginal message ID: tg-msg-${ctx.message_id} | Bot version: 1.0`;
}

export async function writeIssueOrComment(
  gh: GitHubClient,
  repo: string,
  output: ClassifierOutput,
  ctx: WriteContext
): Promise<WriteResult> {
  if (!output.should_create_issue && output.is_followup_to_issue === null) {
    return { kind: "skipped" };
  }

  const sensitiveWarning = output.sensitive
    ? "\n\n⚠️ **Sensitive content detected — original media not attached. Share via a secure channel if needed.**"
    : "";
  const body = output.body_he + sensitiveWarning + attachmentsBlock(ctx.attachments) + mediaErrorsBlock(ctx.media_errors) + metadataFooter(ctx);

  if (output.is_followup_to_issue !== null) {
    try {
      await gh.createComment(repo, output.is_followup_to_issue, body);
      return { kind: "comment", number: output.is_followup_to_issue };
    } catch (e) {
      // The target issue may have been deleted or closed, or GitHub's issue-
      // search index lagged and pointed the classifier at a non-existent issue
      // (createComment → 404). Don't fail the whole request — fall through and
      // create a fresh issue so the client's feedback is never lost.
      console.warn("followup_comment_failed_creating_issue", {
        repo, issue: output.is_followup_to_issue, error: (e as Error).message,
      });
    }
  }

  const labels = [
    "from-telegram",
    `type:${output.type}`,
    `severity:${output.severity}`,
    ...output.suggested_labels,
    ...(output.sensitive ? ["sensitive"] : []),
  ];
  const created = await gh.createIssue(repo, { title: output.title_en, body, labels });
  return { kind: "created", number: created.number, url: created.html_url };
}

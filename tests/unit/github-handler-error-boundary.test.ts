import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleGitHubWebhook } from "../../src/handlers/github";
import { putIssueChat } from "../../src/lib/kv";
import crypto from "node:crypto";

const SECRET = "gh-secret";

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

beforeEach(async () => {
  (env as any).GITHUB_WEBHOOK_SECRET = SECRET;
  (env as any).TELEGRAM_BOT_TOKEN = "tok";
  (env as any).ANTHROPIC_API_KEY = "ak";
  await putIssueChat(env as any, "x/y", 7, { tg_user_id: 50, telegram_chat_id: 50 });
});

describe("handleGitHubWebhook error boundary", () => {
  it("returns 200 and logs when drafter throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = JSON.stringify({
      action: "closed",
      issue: { number: 7, title: "x" },
      repository: { full_name: "x/y" },
      comment: { body: "" },
    });
    const req = new Request("https://w/github/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": sign(body), "X-GitHub-Event": "issues", "content-type": "application/json" },
      body,
    });
    const res = await handleGitHubWebhook(req, env as any, undefined, {
      tgFactory: () => ({ sendMessage: vi.fn(async () => ({ message_id: 1 })) }) as any,
      draftClosure: vi.fn(async () => { throw new Error("anthropic 500"); }) as any,
    });
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith("github_handler_error", expect.objectContaining({ error_message: expect.stringContaining("anthropic 500") }));
    errorSpy.mockRestore();
  });
});

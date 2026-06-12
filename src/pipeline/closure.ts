import type { ClaudeClient } from "../lib/ai";

export interface ClosureContext {
  title: string;
  closing_comment: string;
}

export async function draftClosureMessage(claude: ClaudeClient, ctx: ClosureContext): Promise<string> {
  const reply = await (claude as unknown as { sdk: { messages: { create: (a: unknown) => Promise<any> } } }).sdk.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system: [{
      type: "text",
      text: "You are Ido's AI assistant. Write a warm, brief Hebrew message to a client telling them their reported issue was just resolved. End with '— Ido's AI assistant'. 1-3 sentences.",
    }],
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: `Issue title: ${ctx.title}\nIdo's closing comment: ${ctx.closing_comment}\n\nWrite the Hebrew DM.`,
      }],
    }],
  });
  const block = reply.content?.find((b: any) => b.type === "text");
  return block?.text ?? "הטיקט נסגר.";
}

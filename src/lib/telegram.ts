export function verifyTelegramSecret(req: Request, expected: string): boolean {
  const got = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!got) return false;
  if (got.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < got.length; i++) {
    mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

type FetchLike = typeof fetch;

export class TelegramClient {
  private readonly fetcher: FetchLike;

  constructor(private readonly botToken: string, fetcher: FetchLike = fetch) {
    // Wrap so `this` doesn't leak into the call: globals like fetch enforce a
    // specific `this` binding and throw "Illegal invocation" if called as a
    // method on something else.
    this.fetcher = (input, init) => fetcher(input, init);
  }

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts: { replyToMessageId?: number; parseMode?: "Markdown" | "MarkdownV2" | "HTML" } | number = {},
  ): Promise<{ message_id: number }> {
    // Backwards-compat: 3rd arg used to be replyToMessageId: number.
    const o = typeof opts === "number" ? { replyToMessageId: opts } : opts;
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (o.parseMode) body.parse_mode = o.parseMode;
    if (o.replyToMessageId) body.reply_to_message_id = o.replyToMessageId;
    const res = await this.fetcher(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!json.ok || !json.result) throw new Error(`telegram sendMessage failed: ${json.description}`);
    return { message_id: json.result.message_id };
  }

  async react(chatId: number, messageId: number, emoji: string): Promise<void> {
    await this.fetcher(this.url("setMessageReaction"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      }),
    });
  }

  async getFilePath(fileId: string): Promise<string> {
    const res = await this.fetcher(this.url("getFile"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    const json = (await res.json()) as { ok: boolean; result?: { file_path: string }; description?: string };
    if (!json.ok || !json.result) throw new Error(`telegram getFile failed: ${json.description}`);
    return json.result.file_path;
  }

  async downloadFile(filePath: string): Promise<ArrayBuffer> {
    const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
    const res = await this.fetcher(url);
    if (!res.ok) throw new Error(`telegram downloadFile failed: ${res.status}`);
    return await res.arrayBuffer();
  }

  async sendMessageWithKeyboard(
    chatId: number, text: string,
    inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<{ message_id: number }> {
    const res = await this.fetcher(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId, text,
        reply_markup: { inline_keyboard: inlineKeyboard },
      }),
    });
    const json = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!json.ok || !json.result) throw new Error(`telegram sendMessage failed: ${json.description}`);
    return { message_id: json.result.message_id };
  }

  async editMessageReplyMarkup(
    chatId: number, messageId: number,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    await this.fetcher(this.url("editMessageReplyMarkup"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId,
        reply_markup: { inline_keyboard: inlineKeyboard ?? [] },
      }),
    }).catch(() => {/* swallow — message may be too old to edit */});
  }

  async answerCallbackQuery(
    callbackQueryId: string, opts: { text?: string; show_alert?: boolean } = {},
  ): Promise<void> {
    await this.fetcher(this.url("answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...opts }),
    });
  }

  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
    opts: { scope?: { type: "default" } | { type: "chat"; chat_id: number }; language_code?: string } = {},
  ): Promise<void> {
    await this.fetcher(this.url("setMyCommands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands,
        ...(opts.scope ? { scope: opts.scope } : {}),
        ...(opts.language_code ? { language_code: opts.language_code } : {}),
      }),
    });
  }
}

export interface SendOpts {
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  replyToMessageId?: number;
}

// Escape the three characters Telegram's HTML parse mode treats as markup, so
// arbitrary dynamic text (repo names with underscores, user messages, JSON) can
// be embedded safely. HTML mode is far less fragile than legacy Markdown, which
// silently 400s on an unbalanced _ or * (see CLAUDE.md Telegram-Markdown incident).
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function safeSend(
  tg: Pick<TelegramClient, "sendMessage">,
  chatId: number,
  text: string,
  label: string,
  opts?: SendOpts,
): Promise<{ message_id: number } | null> {
  try {
    return await tg.sendMessage(chatId, text, opts as never);
  } catch (e) {
    console.warn("send_failed", { label, chat_id: chatId, error: (e as Error).message });
    return null;
  }
}

import type { AttachmentRef } from "../types";

export interface ParsedTelegramMessage {
  kind: "message";
  tg_user_id: number;
  chat_id: number;
  message_id: number;
  text: string;
  attachments: AttachmentRef[];
  first_name: string;
}

export interface ParsedCallbackQuery {
  kind: "callback_query";
  callback_query_id: string;
  tg_user_id: number;
  chat_id: number;
  message_id: number;          // the message holding the inline keyboard
  data: string;                // <= 64 bytes
  first_name: string;
}

export interface ParsedUnsupportedMessage {
  kind: "unsupported";
  tg_user_id: number;
  chat_id: number;
  message_id: number;
  unsupported_type: "sticker" | "video_note" | "location" | "poll" | "contact" | "animation";
}

export type ParsedTelegramUpdate = ParsedTelegramMessage | ParsedCallbackQuery | ParsedUnsupportedMessage;

interface RawFile { file_id?: string; file_size?: number }
interface RawMessage {
  message_id?: number;
  from?: { id?: number; first_name?: string };
  chat?: { id?: number };
  text?: string;
  caption?: string;
  photo?: RawFile[];
  voice?: RawFile;
  video?: RawFile;
  document?: RawFile;
  sticker?: { file_id?: string };
  video_note?: { file_id?: string };
  location?: { latitude: number; longitude: number };
  poll?: { id: string };
  contact?: { phone_number: string };
  animation?: { file_id?: string };
}
interface RawCallbackQuery {
  id?: string;
  from?: { id?: number; first_name?: string };
  message?: { message_id?: number; chat?: { id?: number } };
  data?: string;
}
interface RawUpdate { message?: RawMessage; callback_query?: RawCallbackQuery }

export function parseTelegramUpdate(u: unknown): ParsedTelegramUpdate | null {
  const update = u as RawUpdate;

  if (update?.callback_query) {
    const cb = update.callback_query;
    if (
      typeof cb.id !== "string" ||
      typeof cb.from?.id !== "number" ||
      typeof cb.message?.chat?.id !== "number" ||
      typeof cb.message?.message_id !== "number" ||
      typeof cb.data !== "string"
    ) return null;
    return {
      kind: "callback_query",
      callback_query_id: cb.id,
      tg_user_id: cb.from.id,
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      data: cb.data,
      first_name: cb.from.first_name ?? "client",
    };
  }

  const msg = update?.message;
  if (!msg || !msg.from?.id || !msg.chat?.id || typeof msg.message_id !== "number") return null;

  const text: string = msg.text ?? msg.caption ?? "";
  const attachments: AttachmentRef[] = [];
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1]!;
    if (best.file_id) attachments.push({ kind: "photo", telegram_file_id: best.file_id, size_bytes: best.file_size });
  }
  if (msg.voice?.file_id) attachments.push({ kind: "voice", telegram_file_id: msg.voice.file_id, size_bytes: msg.voice.file_size });
  if (msg.video?.file_id) attachments.push({ kind: "video", telegram_file_id: msg.video.file_id, size_bytes: msg.video.file_size });
  if (msg.document?.file_id) attachments.push({ kind: "document", telegram_file_id: msg.document.file_id, size_bytes: msg.document.file_size });

  if (!text && attachments.length === 0) {
    const unsupported_type =
      msg.sticker ? "sticker" :
      msg.video_note ? "video_note" :
      msg.location ? "location" :
      msg.poll ? "poll" :
      msg.contact ? "contact" :
      msg.animation ? "animation" :
      null;
    if (unsupported_type) {
      return {
        kind: "unsupported",
        tg_user_id: msg.from.id, chat_id: msg.chat.id, message_id: msg.message_id,
        unsupported_type,
      };
    }
    return null;
  }

  return {
    kind: "message",
    tg_user_id: msg.from.id, chat_id: msg.chat.id, message_id: msg.message_id,
    text, attachments, first_name: msg.from.first_name ?? "client",
  };
}

import type { TelegramClient } from "./telegram";
import type { ClientRecord } from "../types";

const SINGLE = [
  { command: "start", description: "התחל שיחה" },
  { command: "help", description: "עזרה" },
];

const MULTI = [
  { command: "start", description: "התחל שיחה" },
  { command: "help", description: "עזרה" },
  { command: "use", description: "החלף פרויקט פעיל" },
  { command: "projects", description: "הצג את הפרויקטים שלך" },
];

export async function syncChatMenu(tg: TelegramClient, client: ClientRecord): Promise<void> {
  const commands = client.projects.length > 1 ? MULTI : SINGLE;
  await tg.setMyCommands(commands, {
    scope: { type: "chat", chat_id: client.telegram_chat_id },
    language_code: "he",
  });
}

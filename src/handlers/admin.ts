import type { Env } from "../types";
import type { TelegramClient } from "../lib/telegram";
import { getClient, listClients, isAdmin } from "../lib/kv";
import { syncChatMenu } from "../lib/menu";
import { buildPickerKeyboard } from "../lib/picker";
import {
  createClient, addProject, removeClient, removeProject,
  setDefaultProject, setProjectRepo, setProjectSemantic,
  type ClientAdminDeps, type ValidateRepoFn,
} from "../lib/client-admin";

export interface AdminInput {
  tg_user_id: number;
  chat_id: number;
  text: string;
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]!);
  return out;
}

export type { ValidateRepoFn };

export interface AdminDeps {
  validateRepo?: ValidateRepoFn;
  // Best-effort proactive index build for a newly attached repo. Production wires
  // this to continueIndexBuild under ctx.waitUntil; cron + lazy ingest are the
  // fallbacks if the kickoff is dropped.
  kickoffIndexBuild?: (repo: string) => void;
}

// Repo-validation failure message shared by add and set-repo on the Telegram
// surface (the web surface phrases it differently — see client-admin callers).
function repoValidationHelp(reason?: string): string {
  return (
    `⚠️ Cannot add project: ${reason ?? "invalid repo"}\n\n` +
    `Check that:\n` +
    `  1. The repo exists on GitHub (correct owner/name)\n` +
    `  2. The GitHub App is installed on that repo\n` +
    `  3. The owner string matches GitHub's case (idoZ-H, not workfluxs)`
  );
}

// Wire the Telegram surface's own TelegramClient into the shared mutation module
// so menu syncs use the same client the caller (and tests) injected.
function caDeps(tg: TelegramClient, deps: AdminDeps): ClientAdminDeps {
  return {
    validateRepo: deps.validateRepo,
    syncMenu: (_env, record) => syncChatMenu(tg, record),
    kickoffIndexBuild: deps.kickoffIndexBuild,
  };
}

export async function handleAdminCommand(
  env: Env,
  tg: TelegramClient,
  input: AdminInput,
  deps: AdminDeps = {},
): Promise<boolean> {
  // Strip leading whitespace and invisible control marks (LTR/RTL/BOM) before
  // matching. Telegram clients sometimes inject these when copy-pasting RTL
  // content, and a stray prefix used to silently fall through to the classifier.
  const normalized = input.text.replace(/^[\s‎‏﻿]+/, "");
  if (!normalized.startsWith("/admin")) return false;
  const tokens = tokenize(normalized.trim());
  if (!(await isAdmin(env, input.tg_user_id))) {
    await tg.sendMessage(input.chat_id, "You are not authorized to run /admin commands.");
    return true;
  }
  const ca = caDeps(tg, deps);
  const sub = tokens[1];

  switch (sub) {
    case "add":             return adminAdd(env, tg, input, tokens, ca);
    case "remove":          return adminRemove(env, tg, input, tokens);
    case "remove-project":  return adminRemoveProject(env, tg, input, tokens, ca);
    case "set-default":     return adminSetDefault(env, tg, input, tokens);
    case "set-repo":        return adminSetRepo(env, tg, input, tokens, ca);
    case "set-semantic":    return adminSetSemantic(env, tg, input, tokens, ca);
    case "list":            return adminList(env, tg, input);
    default:
      await tg.sendMessage(input.chat_id, "Commands: /admin add|remove|remove-project|set-default|set-repo|set-semantic|list");
      return true;
  }
}

async function adminAdd(env: Env, tg: TelegramClient, input: AdminInput, tokens: string[], ca: ClientAdminDeps): Promise<boolean> {
  const tgUserId = Number(tokens[2]);
  const name = tokens[3];
  const repo = tokens[4];
  const explicitId = tokens[5];
  const explicitNameHe = tokens[6];
  if (!tgUserId || !name || !repo) {
    await tg.sendMessage(input.chat_id, 'Usage: /admin add <tg_user_id> <name> <owner/repo> [project_id] [project_name_he]');
    return true;
  }

  const existing = await getClient(env, tgUserId);

  if (!existing) {
    const r = await createClient(env, {
      tgUserId, name, repo, projectId: explicitId, projectNameHe: explicitNameHe, semanticEnabled: true,
    }, ca);
    if (!r.ok) {
      // invalid_repo / repo_validation_failed both surface the same guidance.
      await tg.sendMessage(input.chat_id, repoValidationHelp(r.message));
      return true;
    }
    await tg.sendMessage(input.chat_id, `✅ Added ${name} → ${repo}`);
    return true;
  }

  const r = await addProject(env, tgUserId, {
    repo, projectId: explicitId, nameHe: explicitNameHe, semanticEnabled: true, markWelcomedOnFirstMulti: true,
  }, ca);
  if (!r.ok) {
    if (r.reason === "id_conflict") {
      await tg.sendMessage(input.chat_id, `⚠️ Project id "${r.conflictId}" already used for this client. Pass an explicit id or remove the conflict first.`);
    } else if (r.reason === "repo_conflict") {
      await tg.sendMessage(input.chat_id, `⚠️ Repo ${repo} is already attached to project "${r.conflictId}".`);
    } else {
      await tg.sendMessage(input.chat_id, repoValidationHelp(r.message));
    }
    return true;
  }

  // First-time multi-project onboarding DM, then the per-add notice.
  if (r.becameMultiFirstTime) {
    await tg.sendMessageWithKeyboard(
      r.record.telegram_chat_id,
      "שלום! מהיום יש לך כמה פרויקטים. שלח/י הודעה בקשר לפרויקט הפעיל — תוכל/י להחליף בכל זמן עם /use או דרך הכפתורים:",
      buildPickerKeyboard(r.record),
    );
  } else if (r.wasMulti) {
    await tg.sendMessage(r.record.telegram_chat_id, `נוסף פרויקט: ${r.project.name_he}. /projects לרשימה.`);
  }

  await tg.sendMessage(input.chat_id, `✅ Added project ${r.project.id} (${repo}) to ${name}`);
  return true;
}

async function adminRemove(env: Env, tg: TelegramClient, input: AdminInput, tokens: string[]): Promise<boolean> {
  const tgUserId = Number(tokens[2]);
  if (!tgUserId) { await tg.sendMessage(input.chat_id, "Usage: /admin remove <tg_user_id>"); return true; }
  await removeClient(env, tgUserId);
  await tg.sendMessage(input.chat_id, `✅ Removed ${tgUserId}`);
  return true;
}

async function adminRemoveProject(env: Env, tg: TelegramClient, input: AdminInput, tokens: string[], ca: ClientAdminDeps): Promise<boolean> {
  const tgUserId = Number(tokens[2]);
  const projectId = tokens[3];
  if (!tgUserId || !projectId) {
    await tg.sendMessage(input.chat_id, "Usage: /admin remove-project <tg_user_id> <project_id>");
    return true;
  }
  const r = await removeProject(env, tgUserId, projectId, ca);
  if (!r.ok) {
    if (r.reason === "client_not_found") await tg.sendMessage(input.chat_id, "Client not found.");
    else if (r.reason === "only_project") await tg.sendMessage(input.chat_id, "⚠️ Cannot remove the only project. Use /admin remove to delete the client.");
    else await tg.sendMessage(input.chat_id, `Project "${projectId}" not found.`);
    return true;
  }
  if (r.activeChanged) {
    await tg.sendMessage(
      r.record.telegram_chat_id,
      `הפרויקט "${r.removed.name_he ?? projectId}" הוסר. הפרויקט הפעיל עכשיו: ${r.newActive.name_he}.`,
    );
  }
  await tg.sendMessage(input.chat_id, `✅ Removed project ${projectId} from ${r.record.name}`);
  return true;
}

async function adminSetDefault(env: Env, tg: TelegramClient, input: AdminInput, tokens: string[]): Promise<boolean> {
  const tgUserId = Number(tokens[2]);
  const projectId = tokens[3];
  if (!tgUserId || !projectId) {
    await tg.sendMessage(input.chat_id, "Usage: /admin set-default <tg_user_id> <project_id>");
    return true;
  }
  const r = await setDefaultProject(env, tgUserId, projectId);
  if (!r.ok) {
    if (r.reason === "client_not_found") await tg.sendMessage(input.chat_id, "Client not found.");
    else await tg.sendMessage(input.chat_id, `Project "${projectId}" not found.`);
    return true;
  }
  // The default pointer doesn't change the menu's command set, but the Telegram
  // surface has historically re-synced here; keep that, wrapped so a Telegram
  // hiccup can't 500 the webhook (which would trigger a retry storm).
  try {
    await syncChatMenu(tg, r.record);
  } catch (e) {
    console.warn("syncChatMenu_failed_on_set_default", { tgUserId, error: (e as Error).message });
  }
  await tg.sendMessage(input.chat_id, `✅ Default project for ${r.record.name} is now ${projectId}`);
  return true;
}

async function adminSetRepo(env: Env, tg: TelegramClient, input: AdminInput, tokens: string[], ca: ClientAdminDeps): Promise<boolean> {
  const tgUserId = Number(tokens[2]);
  const projectId = tokens[3];
  const newRepo = tokens[4];
  if (!tgUserId || !projectId || !newRepo) {
    await tg.sendMessage(input.chat_id, "Usage: /admin set-repo <tg_user_id> <project_id> <owner/repo>");
    return true;
  }
  const r = await setProjectRepo(env, tgUserId, projectId, newRepo, ca);
  if (!r.ok) {
    switch (r.reason) {
      case "client_not_found":
        await tg.sendMessage(input.chat_id, `Client ${tgUserId} not found.`);
        break;
      case "project_not_found":
        await tg.sendMessage(input.chat_id, `Project "${projectId}" not found for client ${tgUserId}. Available: ${(r.available ?? []).join(", ")}.`);
        break;
      case "no_change":
        await tg.sendMessage(input.chat_id, `Project ${projectId} already points at ${newRepo}.`);
        break;
      case "repo_conflict":
        await tg.sendMessage(input.chat_id, `⚠️ Repo ${newRepo} is already attached to project "${r.conflictId}".`);
        break;
      default:
        await tg.sendMessage(input.chat_id, `⚠️ Cannot set repo: ${r.message ?? "invalid repo"}\nCheck that the repo exists on GitHub and the App is installed there.`);
    }
    return true;
  }
  await tg.sendMessage(input.chat_id, `✅ Project ${projectId}: ${r.oldRepo} → ${r.newRepo}`);
  return true;
}

async function adminSetSemantic(env: Env, tg: TelegramClient, input: AdminInput, tokens: string[], ca: ClientAdminDeps): Promise<boolean> {
  const tgUserId = Number(tokens[2]);
  const projectId = tokens[3];
  const val = tokens[4];
  if (!tgUserId || !projectId || (val !== "on" && val !== "off")) {
    await tg.sendMessage(input.chat_id, "Usage: /admin set-semantic <tg_user_id> <project_id> <on|off>");
    return true;
  }
  const r = await setProjectSemantic(env, tgUserId, projectId, val === "on", ca);
  if (!r.ok) {
    if (r.reason === "client_not_found") await tg.sendMessage(input.chat_id, `Client ${tgUserId} not found.`);
    else await tg.sendMessage(input.chat_id, `Project "${projectId}" not found. Available: ${(r.available ?? []).join(", ")}.`);
    return true;
  }
  await tg.sendMessage(input.chat_id, `✅ semantic_enabled=${r.enabled} for ${projectId} (${r.project.repo})`);
  return true;
}

async function adminList(env: Env, tg: TelegramClient, input: AdminInput): Promise<boolean> {
  const list = await listClients(env);
  const text = list.length === 0
    ? "(no clients)"
    : list.map((c) => {
        const projects = c.record.projects
          .map((p) => `${p.id === c.record.active_project_id ? "*" : ""}${p.id} (${p.repo})`)
          .join(", ");
        return `- ${c.tg_user_id}: ${c.record.name} → ${projects} (${c.record.active ? "active" : "inactive"})`;
      }).join("\n");
  await tg.sendMessage(input.chat_id, text);
  return true;
}

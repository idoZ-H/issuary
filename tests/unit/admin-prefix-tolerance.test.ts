import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleAdminCommand } from "../../src/handlers/admin";
import { putAdmin, getClient } from "../../src/lib/kv";

beforeEach(async () => {
  await putAdmin(env as any, 1);
});

const okValidate = { validateRepo: async () => ({ ok: true } as const) };

describe("handleAdminCommand prefix tolerance", () => {
  it("matches /admin with leading whitespace", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "  /admin add 90 Bob org/foo",
    }, okValidate);
    expect(handled).toBe(true);
    const c = await getClient(env as any, 90);
    expect(c?.name).toBe("Bob");
  });

  it("matches /admin with leading LTR mark (U+200E)", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "‎/admin add 91 Carol org/bar",
    }, okValidate);
    expect(handled).toBe(true);
    const c = await getClient(env as any, 91);
    expect(c?.name).toBe("Carol");
  });

  it("matches /admin with leading RTL mark (U+200F)", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "‏/admin add 92 Dave org/baz",
    }, okValidate);
    expect(handled).toBe(true);
    const c = await getClient(env as any, 92);
    expect(c?.name).toBe("Dave");
  });

  it("matches /admin with leading BOM (U+FEFF)", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "﻿/admin add 93 Eve org/qux",
    }, okValidate);
    expect(handled).toBe(true);
    const c = await getClient(env as any, 93);
    expect(c?.name).toBe("Eve");
  });

  it("does NOT match text that contains /admin mid-string", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "tell me about /admin add",
    });
    expect(handled).toBe(false);
  });
});

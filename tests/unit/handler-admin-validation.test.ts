import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleAdminCommand } from "../../src/handlers/admin";
import { putAdmin, getClient } from "../../src/lib/kv";

beforeEach(async () => {
  await putAdmin(env as any, 1);
});

describe("/admin add validation", () => {
  it("persists the client when validateRepo returns ok", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const validateRepo = vi.fn(async () => ({ ok: true } as const));
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 200 Yossi org/valid-repo",
    }, { validateRepo });
    expect(handled).toBe(true);
    expect(validateRepo).toHaveBeenCalledWith(env, "org/valid-repo");
    const c = await getClient(env as any, 200);
    expect(c?.name).toBe("Yossi");
    expect(c?.projects[0]?.repo).toBe("org/valid-repo");
    expect((tg.sendMessage.mock.calls as any[]).some((c: any[]) => /✅ Added/.test(c[1]))).toBe(true);
  });

  it("rejects /admin add when validateRepo returns ok=false (App not installed)", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const validateRepo = vi.fn(async () => ({ ok: false, reason: "github app: no installation found for org/missing-repo (HTTP 404)" } as const));
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 201 Bob org/missing-repo",
    }, { validateRepo });
    expect(handled).toBe(true);
    const c = await getClient(env as any, 201);
    expect(c).toBeNull();  // not persisted
    const reply = (tg.sendMessage.mock.calls as any[])[0][1];
    expect(reply).toMatch(/Cannot add project/);
    expect(reply).toMatch(/no installation found/);
  });

  it("rejects /admin add when repo does not exist (HTTP 404 on /repos/X)", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const validateRepo = vi.fn(async () => ({ ok: false, reason: "github app: no installation found for nope/nope (HTTP 404). Install the App on this repo first." } as const));
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 202 Carol nope/nope",
    }, { validateRepo });
    expect(handled).toBe(true);
    const c = await getClient(env as any, 202);
    expect(c).toBeNull();
  });
});

describe("/admin set-repo", () => {
  beforeEach(async () => {
    // Set up a client with two projects
    const tg = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      sendMessageWithKeyboard: vi.fn(async () => ({ message_id: 1 })),
      setMyCommands: vi.fn(async () => {}),
    };
    const okValidate = { validateRepo: async () => ({ ok: true } as const) };
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 300 Eve org/first",
    }, okValidate);
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 300 Eve org/second second",
    }, okValidate);
  });

  it("updates the project's repo when validation succeeds", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const validateRepo = vi.fn(async () => ({ ok: true } as const));
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin set-repo 300 first org/renamed",
    }, { validateRepo });
    expect(handled).toBe(true);
    const c = await getClient(env as any, 300);
    const project = c?.projects.find((p) => p.id === "first");
    expect(project?.repo).toBe("org/renamed");
    const reply = (tg.sendMessage.mock.calls as any[])[0][1];
    expect(reply).toMatch(/✅ Project first: org\/first → org\/renamed/);
  });

  it("rejects when client doesn't exist", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin set-repo 999 first org/whatever",
    });
    expect(handled).toBe(true);
    const reply = (tg.sendMessage.mock.calls as any[])[0][1];
    expect(reply).toMatch(/Client 999 not found/);
  });

  it("rejects when project_id doesn't exist for the client", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin set-repo 300 nope org/whatever",
    });
    expect(handled).toBe(true);
    const reply = (tg.sendMessage.mock.calls as any[])[0][1];
    expect(reply).toMatch(/Project "nope" not found/);
    expect(reply).toMatch(/Available: first, second/);
  });

  it("no-ops when the new repo equals the current repo", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    const validateRepo = vi.fn(async () => ({ ok: true } as const));
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin set-repo 300 first org/first",
    }, { validateRepo });
    expect(handled).toBe(true);
    expect(validateRepo).not.toHaveBeenCalled();  // short-circuit before validation
    const reply = (tg.sendMessage.mock.calls as any[])[0][1];
    expect(reply).toMatch(/already points at org\/first/);
  });

  it("rejects when new repo conflicts with another project on the same client", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin set-repo 300 first org/second",
    });
    expect(handled).toBe(true);
    const reply = (tg.sendMessage.mock.calls as any[])[0][1];
    expect(reply).toMatch(/already attached to project "second"/);
  });

  it("rejects when validateRepo says App not installed on the new repo", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    const validateRepo = vi.fn(async () => ({ ok: false, reason: "App not installed on org/elsewhere" } as const));
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin set-repo 300 first org/elsewhere",
    }, { validateRepo });
    expect(handled).toBe(true);
    const c = await getClient(env as any, 300);
    expect(c?.projects.find((p) => p.id === "first")?.repo).toBe("org/first");  // unchanged
    const reply = (tg.sendMessage.mock.calls as any[])[0][1];
    expect(reply).toMatch(/Cannot set repo/);
  });

  it("usage message when arguments are missing", async () => {
    const tg = { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin set-repo",
    });
    expect(handled).toBe(true);
    const reply = (tg.sendMessage.mock.calls as any[])[0][1];
    expect(reply).toMatch(/Usage: \/admin set-repo/);
  });
});

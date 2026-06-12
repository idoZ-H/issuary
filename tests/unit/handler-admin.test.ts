import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleAdminCommand } from "../../src/handlers/admin";
import { putAdmin, getClient } from "../../src/lib/kv";

beforeEach(async () => {
  await putAdmin(env as any, 1);
});

const okValidate = { validateRepo: async () => ({ ok: true } as const) };

describe("handleAdminCommand", () => {
  it("rejects non-admins", async () => {
    const tg = { sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 999, chat_id: 999, text: "/admin add 50 Yossi x/y",
    });
    expect(handled).toBe(true);
    expect((tg.sendMessage.mock.calls as any[])[0]![1]).toMatch(/not authorized/i);
  });

  it("/admin add registers a new client", async () => {
    const tg = { sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 50 Yossi x/acme-core",
    }, okValidate);
    expect(handled).toBe(true);
    const c = await getClient(env as any, 50);
    expect(c?.name).toBe("Yossi");
    expect(c?.projects[0]?.repo).toBe("x/acme-core");
    expect(c?.active).toBe(true);
  });

  it("/admin add accepts a double-quoted multi-word name", async () => {
    const tg = { sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: '/admin add 80 "Globex Corp" Globex-Inc/WebApp',
    }, okValidate);
    expect(handled).toBe(true);
    const c = await getClient(env as any, 80);
    expect(c?.name).toBe("Globex Corp");
    // Repo is canonicalized (lowercased) so all clients/webhooks share one
    // CODE_INDEX_META key regardless of the casing the admin typed.
    expect(c?.projects[0]?.repo).toBe("globex-inc/webapp");
  });

  it("/admin remove deletes a client", async () => {
    const tg = { sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 60 Bob org/repo",
    }, okValidate);
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin remove 60",
    });
    const c = await getClient(env as any, 60);
    expect(c).toBeNull();
  });

  it("/admin list shows registered clients", async () => {
    const tg = { sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 70 Alice org/repo",
    }, okValidate);
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin list",
    });
    const lastCall = (tg.sendMessage.mock.calls as any[]).at(-1);
    expect(lastCall![1]).toContain("Alice");
    expect(lastCall![1]).toContain("org/repo");
  });

  it("returns false for non-/admin messages", async () => {
    const tg = { sendMessage: vi.fn() };
    const handled = await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "hello world",
    });
    expect(handled).toBe(false);
  });

  it("/admin add to an existing client adds a second project", async () => {
    const tg = {
      sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })),
      setMyCommands: vi.fn(async () => {}),
      sendMessageWithKeyboard: vi.fn(async (_c: number, _t: string, _kb: any) => ({ message_id: 2 })),
    };
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: '/admin add 50 Yossi x/acme-core',
    }, okValidate);
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: '/admin add 50 Yossi x/acme-mobile acme-mobile "אקמי מובייל"',
    }, okValidate);
    const c = await getClient(env as any, 50);
    expect(c?.projects).toHaveLength(2);
    expect(c?.projects.map((p) => p.id)).toContain("acme-mobile");
    expect(c?.projects.find((p) => p.id === "acme-mobile")?.name_he).toBe("אקמי מובייל");
  });

  it("/admin add rejects a colliding project_id", async () => {
    const tg = { sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}), sendMessageWithKeyboard: vi.fn(async (_c: number, _t: string, _kb: any) => ({ message_id: 2 })) };
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 51 Yossi x/foo",
    }, okValidate);
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 51 Yossi y/foo",
    }, okValidate);
    const lastReply = (tg.sendMessage.mock.calls as any[]).at(-1)![1];
    expect(lastReply).toMatch(/already used|כבר משויך/i);
  });

  it("/admin add second project triggers menu sync and onboarding DM", async () => {
    const tg = {
      sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })),
      setMyCommands: vi.fn(async () => {}),
      sendMessageWithKeyboard: vi.fn(async (_c: number, _t: string, _kb: any) => ({ message_id: 2 })),
    };
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: '/admin add 52 Yossi x/a' }, okValidate);
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: '/admin add 52 Yossi x/b b "שני"' }, okValidate);
    expect(tg.setMyCommands).toHaveBeenCalled();
    expect(tg.sendMessageWithKeyboard).toHaveBeenCalled();
    const c = await getClient(env as any, 52);
    expect(c?.welcomed_multi_at).toBeDefined();
  });

  it("/admin add second project does NOT re-send onboarding when welcomed_multi_at is set", async () => {
    const tg = {
      sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })),
      setMyCommands: vi.fn(async () => {}),
      sendMessageWithKeyboard: vi.fn(async (_c: number, _t: string, _kb: any) => ({ message_id: 2 })),
    };
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: '/admin add 53 Yossi x/a' }, okValidate);
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: '/admin add 53 Yossi x/b' }, okValidate);
    expect((tg.sendMessageWithKeyboard.mock.calls as any[]).length).toBe(1);
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: '/admin add 53 Yossi x/c' }, okValidate);
    expect((tg.sendMessageWithKeyboard.mock.calls as any[]).length).toBe(1);  // still 1 — no re-onboarding
  });

  it("/admin add sets semantic_enabled true and kicks off the index build", async () => {
    const tg = { sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const kicked: string[] = [];
    await handleAdminCommand(env as any, tg as any, {
      tg_user_id: 1, chat_id: 1, text: "/admin add 555 Acme owner/repo",
    }, { ...okValidate, kickoffIndexBuild: (r: string) => kicked.push(r) });
    const raw = await (env as any).CLIENTS.get("555", "json");
    expect(raw.projects[0].semantic_enabled).toBe(true);
    expect(kicked).toContain("owner/repo");
  });

  it("/admin add of a second project sets semantic_enabled true and kicks off the build", async () => {
    const tg = {
      sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })),
      setMyCommands: vi.fn(async () => {}),
      sendMessageWithKeyboard: vi.fn(async (_c: number, _t: string, _kb: any) => ({ message_id: 2 })),
    };
    const kicked: string[] = [];
    const deps = { ...okValidate, kickoffIndexBuild: (r: string) => kicked.push(r) };
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: "/admin add 556 Acme x/first" }, deps);
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: "/admin add 556 Acme x/second second" }, deps);
    const raw = await (env as any).CLIENTS.get("556", "json");
    expect(raw.projects.find((p: any) => p.id === "second").semantic_enabled).toBe(true);
    expect(kicked).toContain("x/second");
  });

  it("/admin set-semantic off flips the project flag to false", async () => {
    const tg = { sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: "/admin add 600 Acme x/repo" }, okValidate);
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: "/admin set-semantic 600 repo off" });
    const c = await getClient(env as any, 600);
    expect(c!.projects.find((p) => p.id === "repo")!.semantic_enabled).toBe(false);
  });

  it("/admin set-semantic on flips the project flag back to true and kicks off the build", async () => {
    const tg = { sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    const kicked: string[] = [];
    const deps = { ...okValidate, kickoffIndexBuild: (r: string) => kicked.push(r) };
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: "/admin add 601 Acme x/repo" }, deps);
    kicked.length = 0;  // ignore the kickoff from the add itself
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: "/admin set-semantic 601 repo off" }, deps);
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: "/admin set-semantic 601 repo on" }, deps);
    const c = await getClient(env as any, 601);
    expect(c!.projects.find((p) => p.id === "repo")!.semantic_enabled).toBe(true);
    expect(kicked).toEqual(["x/repo"]);  // only the "on" kicked off, not the "off"
  });

  it("/admin set-semantic rejects a bad on/off value with usage", async () => {
    const tg = { sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })), setMyCommands: vi.fn(async () => {}) };
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: "/admin set-semantic 602 repo maybe" });
    expect((tg.sendMessage.mock.calls as any[]).at(-1)![1]).toMatch(/Usage: \/admin set-semantic/);
  });

  it("/admin set-default calls syncChatMenu", async () => {
    const tg = {
      sendMessage: vi.fn(async (_c: number, _t: string) => ({ message_id: 1 })),
      setMyCommands: vi.fn(async () => {}),
      sendMessageWithKeyboard: vi.fn(async (_c: number, _t: string, _kb: any) => ({ message_id: 2 })),
    };
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: '/admin add 60 Yossi x/a' }, okValidate);
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: '/admin add 60 Yossi x/b' }, okValidate);
    const before = tg.setMyCommands.mock.calls.length;
    await handleAdminCommand(env as any, tg as any, { tg_user_id: 1, chat_id: 1, text: '/admin set-default 60 b' });
    expect(tg.setMyCommands.mock.calls.length).toBeGreaterThan(before);
    const c = await getClient(env as any, 60);
    expect(c?.default_project_id).toBe("b");
  });
});

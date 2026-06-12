import { describe, it, expect, vi } from "vitest";
import { syncChatMenu } from "../../src/lib/menu";

const sampleClient = (n: number) => ({
  name: "Yossi", telegram_chat_id: 99, active: true, created_at: "2026-05-08T00:00:00Z",
  projects: Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, name_he: `P${i}`, repo: `x/p${i}`, created_at: "2026-05-08T00:00:00Z",
  })),
  active_project_id: "p0", default_project_id: "p0",
});

describe("syncChatMenu", () => {
  it("sets the single-project menu (start, help) when projects.length === 1", async () => {
    const tg = { setMyCommands: vi.fn(async () => {}) };
    await syncChatMenu(tg as any, sampleClient(1));
    const args = (tg.setMyCommands.mock.calls as any[])[0]!;
    const cmds = (args[0] as any[]).map((c: any) => c.command);
    expect(cmds).toEqual(["start", "help"]);
    expect(args[1].scope.chat_id).toBe(99);
    expect(args[1].language_code).toBe("he");
  });

  it("sets the multi-project menu (start, help, use, projects) when projects.length > 1", async () => {
    const tg = { setMyCommands: vi.fn(async () => {}) };
    await syncChatMenu(tg as any, sampleClient(3));
    const cmds = ((tg.setMyCommands.mock.calls as any[])[0]![0] as any[]).map((c: any) => c.command);
    expect(cmds).toEqual(["start", "help", "use", "projects"]);
  });
});

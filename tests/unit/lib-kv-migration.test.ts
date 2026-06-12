import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getClient, getActiveProject, listClients } from "../../src/lib/kv";

describe("getClient backwards-compat", () => {
  it("normalizes a legacy single-project record into the new shape", async () => {
    // Write a legacy record directly (bypassing putClient's new-shape writer).
    await (env as any).CLIENTS.put("777", JSON.stringify({
      name: "Yossi", repo: "workfluxs/acme-core",
      telegram_chat_id: 777, active: true,
      created_at: "2026-04-29T00:00:00Z",
    }));
    const c = await getClient(env as any, 777);
    expect(c).not.toBeNull();
    expect(c!.projects).toHaveLength(1);
    expect(c!.projects[0]!.id).toBe("acme-core");
    expect(c!.projects[0]!.repo).toBe("workfluxs/acme-core");
    expect(c!.projects[0]!.name_he).toBe("Yossi");
    expect(c!.active_project_id).toBe("acme-core");
    expect(c!.default_project_id).toBe("acme-core");
  });

  it("returns a new-shape record unchanged", async () => {
    await (env as any).CLIENTS.put("778", JSON.stringify({
      name: "Avi", telegram_chat_id: 778, active: true,
      created_at: "2026-05-08T00:00:00Z",
      projects: [{ id: "acme", name_he: "ACME", repo: "x/acme", created_at: "2026-05-08T00:00:00Z" }],
      active_project_id: "acme", default_project_id: "acme",
    }));
    const c = await getClient(env as any, 778);
    expect(c!.projects).toHaveLength(1);
    expect(c!.projects[0]!.id).toBe("acme");
  });
});

describe("getActiveProject", () => {
  it("returns the project matching active_project_id", async () => {
    const client = {
      name: "X", telegram_chat_id: 1, active: true, created_at: "2026-05-08T00:00:00Z",
      projects: [
        { id: "a", name_he: "A", repo: "x/a", created_at: "2026-05-08T00:00:00Z" },
        { id: "b", name_he: "B", repo: "x/b", created_at: "2026-05-08T00:00:00Z" },
      ],
      active_project_id: "b", default_project_id: "a",
    } as any;
    expect(getActiveProject(client).id).toBe("b");
  });
});

describe("listClients backwards-compat", () => {
  it("normalizes legacy records from KV.list", async () => {
    await (env as any).CLIENTS.put("900", JSON.stringify({
      name: "Legacy Yossi", repo: "x/legacy",
      telegram_chat_id: 900, active: true,
      created_at: "2026-04-01T00:00:00Z",
    }));
    const list = await listClients(env as any);
    const found = list.find((c) => c.tg_user_id === 900);
    expect(found).toBeDefined();
    expect(found!.record.projects).toHaveLength(1);
    expect(found!.record.projects[0]!.id).toBe("legacy");
    expect(found!.record.active_project_id).toBe("legacy");
  });
});

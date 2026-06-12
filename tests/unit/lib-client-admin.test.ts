import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  createClient, addProject, removeClient, removeProject,
  setDefaultProject, setActiveProject, setProjectRepo, setProjectSemantic, updateClient,
  slugFromRepo, isValidRepoFormat,
} from "../../src/lib/client-admin";
import { getClient, putClient } from "../../src/lib/kv";
import type { ClientRecord } from "../../src/types";

const okValidate = async () => ({ ok: true } as const);

function makeDeps(extra: Record<string, unknown> = {}) {
  return {
    validateRepo: okValidate,
    syncMenu: vi.fn(async () => {}),
    kickoffIndexBuild: vi.fn(),
    ...extra,
  };
}

async function seed(tgUserId: number, record: Partial<ClientRecord> & { projects: ClientRecord["projects"] }): Promise<void> {
  await putClient(env as any, tgUserId, {
    name: "Acme", telegram_chat_id: tgUserId, active: true, created_at: "2026-01-01T00:00:00Z",
    active_project_id: record.projects[0]!.id, default_project_id: record.projects[0]!.id,
    ...record,
  } as ClientRecord);
}

describe("client-admin pure helpers", () => {
  it("slugFromRepo lowercases the repo tail and strips junk", () => {
    expect(slugFromRepo("idoZ-H/Acme_Core")).toBe("acme-core");
    expect(slugFromRepo("owner/repo")).toBe("repo");
  });
  it("isValidRepoFormat requires owner/repo", () => {
    expect(isValidRepoFormat("owner/repo")).toBe(true);
    expect(isValidRepoFormat("norepo")).toBe(false);
    expect(isValidRepoFormat("a/b/c")).toBe(false);
    expect(isValidRepoFormat("")).toBe(false);
  });
});

describe("createClient", () => {
  it("creates a one-project client, syncs the menu, and kicks off when semantic on", async () => {
    const deps = makeDeps();
    const r = await createClient(env as any, { tgUserId: 800, name: "Acme", repo: "owner/repo", semanticEnabled: true }, deps);
    expect(r.ok).toBe(true);
    const stored = await getClient(env as any, 800);
    expect(stored?.projects[0]!.repo).toBe("owner/repo");
    expect(deps.syncMenu).toHaveBeenCalledOnce();
    expect(deps.kickoffIndexBuild).toHaveBeenCalledWith("owner/repo");
  });

  it("does not kick off the build when semantic is off", async () => {
    const deps = makeDeps();
    await createClient(env as any, { tgUserId: 801, name: "Acme", repo: "owner/repo", semanticEnabled: false }, deps);
    expect(deps.kickoffIndexBuild).not.toHaveBeenCalled();
  });

  it("rejects a duplicate client", async () => {
    await seed(802, { projects: [{ id: "p", name_he: "P", repo: "x/p", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }] });
    const r = await createClient(env as any, { tgUserId: 802, name: "Acme", repo: "owner/repo", semanticEnabled: true }, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("client_exists");
  });

  it("rejects when repo validation fails", async () => {
    const deps = makeDeps({ validateRepo: async () => ({ ok: false as const, reason: "no install" }) });
    const r = await createClient(env as any, { tgUserId: 803, name: "Acme", repo: "owner/repo", semanticEnabled: true }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("repo_validation_failed");
    expect(deps.kickoffIndexBuild).not.toHaveBeenCalled();
  });
});

describe("addProject", () => {
  beforeEach(async () => {
    await seed(810, { projects: [{ id: "first", name_he: "F", repo: "x/first", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }] });
  });

  it("appends a project, syncs the menu, and kicks off the build", async () => {
    const deps = makeDeps();
    const r = await addProject(env as any, 810, { repo: "x/second", semanticEnabled: true }, deps);
    expect(r.ok).toBe(true);
    const stored = await getClient(env as any, 810);
    expect(stored?.projects.map((p) => p.id)).toContain("second");
    expect(deps.syncMenu).toHaveBeenCalledOnce();
    expect(deps.kickoffIndexBuild).toHaveBeenCalledWith("x/second");
  });

  it("rejects a colliding project id", async () => {
    const r = await addProject(env as any, 810, { repo: "x/other", projectId: "first", semanticEnabled: true }, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("id_conflict");
  });

  it("rejects a repo already attached to another project", async () => {
    // Distinct project id, but the repo collides with the existing "first" project.
    const r = await addProject(env as any, 810, { repo: "x/first", projectId: "dup", semanticEnabled: true }, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe("repo_conflict"); expect(r.conflictId).toBe("first"); }
  });

  it("reports becameMultiFirstTime when crossing 1→2 and markWelcomed is set", async () => {
    const r = await addProject(env as any, 810, { repo: "x/second", semanticEnabled: false, markWelcomedOnFirstMulti: true }, makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.becameMultiFirstTime).toBe(true);
    const stored = await getClient(env as any, 810);
    expect(stored?.welcomed_multi_at).toBeTruthy();
  });

  it("does not set welcomed_multi_at when markWelcomed is not requested (web path)", async () => {
    const r = await addProject(env as any, 810, { repo: "x/second", semanticEnabled: false }, makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.becameMultiFirstTime).toBe(false);
    const stored = await getClient(env as any, 810);
    expect(stored?.welcomed_multi_at).toBeUndefined();
  });
});

describe("removeProject invariant repair", () => {
  it("reassigns active and default when the removed project held them", async () => {
    await seed(820, {
      projects: [
        { id: "a", name_he: "A", repo: "x/a", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true },
        { id: "b", name_he: "B", repo: "x/b", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true },
      ],
      active_project_id: "a", default_project_id: "a",
    });
    const deps = makeDeps();
    const r = await removeProject(env as any, 820, "a", deps);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.activeChanged).toBe(true); expect(r.newActive.id).toBe("b"); }
    const stored = await getClient(env as any, 820);
    expect(stored?.active_project_id).toBe("b");
    expect(stored?.default_project_id).toBe("b");
    expect(deps.syncMenu).toHaveBeenCalledOnce();
  });

  it("refuses to remove the only project", async () => {
    await seed(821, { projects: [{ id: "p", name_he: "P", repo: "x/p", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }] });
    const r = await removeProject(env as any, 821, "p", makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("only_project");
  });
});

describe("setProjectRepo", () => {
  beforeEach(async () => {
    await seed(830, {
      projects: [
        { id: "a", name_he: "A", repo: "x/a", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true },
        { id: "b", name_he: "B", repo: "x/b", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true },
      ],
    });
  });
  it("rejects a repo already used by a sibling project", async () => {
    const r = await setProjectRepo(env as any, 830, "a", "x/b", makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe("repo_conflict"); expect(r.conflictId).toBe("b"); }
  });
  it("updates the repo and reports old→new", async () => {
    const r = await setProjectRepo(env as any, 830, "a", "x/aa", makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.oldRepo).toBe("x/a"); expect(r.newRepo).toBe("x/aa"); }
    const stored = await getClient(env as any, 830);
    expect(stored?.projects.find((p) => p.id === "a")?.repo).toBe("x/aa");
  });
});

describe("setProjectSemantic", () => {
  beforeEach(async () => {
    await seed(840, { projects: [{ id: "p", name_he: "P", repo: "x/p", created_at: "2026-01-01T00:00:00Z", semantic_enabled: false }] });
  });
  it("enables and kicks off the build", async () => {
    const deps = makeDeps();
    await setProjectSemantic(env as any, 840, "p", true, deps);
    const stored = await getClient(env as any, 840);
    expect(stored?.projects[0]!.semantic_enabled).toBe(true);
    expect(deps.kickoffIndexBuild).toHaveBeenCalledWith("x/p");
  });
  it("disables without kicking off", async () => {
    const deps = makeDeps();
    await setProjectSemantic(env as any, 840, "p", false, deps);
    expect(deps.kickoffIndexBuild).not.toHaveBeenCalled();
  });
});

describe("setDefaultProject / setActiveProject / updateClient / removeClient", () => {
  beforeEach(async () => {
    await seed(850, {
      projects: [
        { id: "a", name_he: "A", repo: "x/a", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true },
        { id: "b", name_he: "B", repo: "x/b", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true },
      ],
    });
  });
  it("setDefaultProject sets the default (no menu sync — count is unchanged)", async () => {
    const r = await setDefaultProject(env as any, 850, "b");
    expect(r.ok).toBe(true);
    expect((await getClient(env as any, 850))?.default_project_id).toBe("b");
  });
  it("setActiveProject sets the active project", async () => {
    const r = await setActiveProject(env as any, 850, "b");
    expect(r.ok).toBe(true);
    expect((await getClient(env as any, 850))?.active_project_id).toBe("b");
  });
  it("setDefaultProject rejects an unknown project", async () => {
    const r = await setDefaultProject(env as any, 850, "zzz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("project_not_found");
  });
  it("updateClient updates name/active/shadow", async () => {
    const r = await updateClient(env as any, 850, { name: "Renamed", active: false, shadowMode: true });
    expect(r.ok).toBe(true);
    const stored = await getClient(env as any, 850);
    expect(stored?.name).toBe("Renamed");
    expect(stored?.active).toBe(false);
    expect(stored?.shadow_mode).toBe(true);
  });
  it("removeClient deletes the record", async () => {
    await removeClient(env as any, 850);
    expect(await getClient(env as any, 850)).toBeNull();
  });
  it("setDefaultProject reports client_not_found for a missing client", async () => {
    const r = await setDefaultProject(env as any, 99999, "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("client_not_found");
  });
});

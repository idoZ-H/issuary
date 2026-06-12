// Repo strings are the join key between a client's project and that repo's
// shared code-index manifest (CODE_INDEX_META is keyed by "owner/repo"). GitHub
// owner/repo names are case-insensitive but case-PRESERVING, so two clients can
// reference the same repo under different casing ("idoZ-H/Foo" vs "idoz-h/foo")
// and end up with two separate manifests — one client shows the index as
// "missing" and the repo gets indexed twice. These tests pin the fix:
// canonicalize the repo string (lowercase + trim) at every entry point so all
// clients and both webhooks converge on one KV key.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { canonicalizeRepo, getClient, putClient, listClients } from "../../src/lib/kv";
import { createClient, addProject, setProjectRepo } from "../../src/lib/client-admin";
import { handleGitHubWebhook } from "../../src/handlers/github";
import type { ClientRecord } from "../../src/types";

const okValidate = async () => ({ ok: true } as const);
const deps = () => ({ validateRepo: okValidate, syncMenu: async () => {}, kickoffIndexBuild: () => {} });

describe("canonicalizeRepo", () => {
  it("lowercases owner and repo", () => {
    expect(canonicalizeRepo("idoZ-H/Foo")).toBe("idoz-h/foo");
  });
  it("trims surrounding whitespace", () => {
    expect(canonicalizeRepo("  owner/repo  ")).toBe("owner/repo");
  });
  it("leaves an already-canonical repo unchanged", () => {
    expect(canonicalizeRepo("owner/repo")).toBe("owner/repo");
  });
});

describe("getClient canonicalizes stored project repos", () => {
  it("lowercases a mixed-case repo in a new-shape record (auto-heals legacy mismatches)", async () => {
    await (env as any).CLIENTS.put("1001", JSON.stringify({
      name: "Acme", telegram_chat_id: 1001, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "foo", name_he: "Foo", repo: "idoZ-H/Foo", created_at: "2026-01-01T00:00:00Z" }],
      active_project_id: "foo", default_project_id: "foo",
    }));
    const c = await getClient(env as any, 1001);
    expect(c!.projects[0]!.repo).toBe("idoz-h/foo");
  });

  it("lowercases the repo when normalizing a legacy single-repo record", async () => {
    await (env as any).CLIENTS.put("1002", JSON.stringify({
      name: "Legacy", repo: "idoZ-H/Bar", telegram_chat_id: 1002, active: true,
      created_at: "2026-01-01T00:00:00Z",
    }));
    const c = await getClient(env as any, 1002);
    expect(c!.projects[0]!.repo).toBe("idoz-h/bar");
  });

  it("canonicalizes repos returned by listClients too", async () => {
    await (env as any).CLIENTS.put("1003", JSON.stringify({
      name: "L", repo: "Owner/Repo", telegram_chat_id: 1003, active: true, created_at: "2026-01-01T00:00:00Z",
    }));
    const found = (await listClients(env as any)).find((c) => c.tg_user_id === 1003);
    expect(found!.record.projects[0]!.repo).toBe("owner/repo");
  });
});

describe("createClient stores the canonical repo", () => {
  it("persists lowercase and kicks off the build under the canonical key", async () => {
    const kicked: string[] = [];
    const r = await createClient(env as any, { tgUserId: 1010, name: "Acme", repo: "idoZ-H/Foo", semanticEnabled: true },
      { ...deps(), kickoffIndexBuild: (repo: string) => kicked.push(repo) });
    expect(r.ok).toBe(true);
    expect((await getClient(env as any, 1010))!.projects[0]!.repo).toBe("idoz-h/foo");
    expect(kicked).toEqual(["idoz-h/foo"]);
  });
});

describe("addProject treats case-variant repos as the same repo", () => {
  it("rejects a differently-cased duplicate of an existing project's repo", async () => {
    await putClient(env as any, 1020, {
      name: "Acme", telegram_chat_id: 1020, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "foo", name_he: "Foo", repo: "idoz-h/foo", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }],
      active_project_id: "foo", default_project_id: "foo",
    } as ClientRecord);
    const r = await addProject(env as any, 1020, { repo: "idoZ-H/Foo", projectId: "foo2", semanticEnabled: true }, deps());
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("repo_conflict");
  });
});

describe("setProjectRepo canonicalizes", () => {
  it("treats a case-only edit as no change (same canonical repo)", async () => {
    await putClient(env as any, 1030, {
      name: "Acme", telegram_chat_id: 1030, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "foo", name_he: "Foo", repo: "idoz-h/foo", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }],
      active_project_id: "foo", default_project_id: "foo",
    } as ClientRecord);
    const r = await setProjectRepo(env as any, 1030, "foo", "idoZ-H/Foo", deps());
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("no_change");
  });

  it("stores the canonical form when the repo genuinely changes", async () => {
    await putClient(env as any, 1031, {
      name: "Acme", telegram_chat_id: 1031, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "foo", name_he: "Foo", repo: "idoz-h/foo", created_at: "2026-01-01T00:00:00Z", semantic_enabled: true }],
      active_project_id: "foo", default_project_id: "foo",
    } as ClientRecord);
    const r = await setProjectRepo(env as any, 1031, "foo", "idoZ-H/Bar", deps());
    expect(r.ok).toBe(true);
    expect((await getClient(env as any, 1031))!.projects[0]!.repo).toBe("idoz-h/bar");
  });
});

describe("push webhook canonicalizes GitHub's case-preserving full_name", () => {
  const SECRET = "gh-secret";
  async function sign(body: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function pushReq(payload: any): Promise<Request> {
    const body = JSON.stringify(payload);
    return new Request("https://w/github/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": await sign(body), "content-type": "application/json", "X-GitHub-Event": "push" },
      body,
    });
  }

  it("matches a canonical project repo when GitHub sends mixed-case full_name", async () => {
    (env as any).GITHUB_WEBHOOK_SECRET = SECRET;
    let appliedRepo: string | null = null;
    const payload = {
      ref: "refs/heads/main", after: "headsha",
      repository: { full_name: "idoZ-H/Foo", default_branch: "main" }, // GitHub's actual case
      commits: [{ added: ["src/a.ts"], modified: [], removed: [] }],
    };
    const res = await handleGitHubWebhook(await pushReq(payload), env as any, undefined, {
      // Project stored canonically (as getClient now returns it).
      listClientsFn: async () => [{ tg_user_id: 1, record: { projects: [{ repo: "idoz-h/foo", semantic_enabled: true }] } } as any],
      buildGh: async () => ({} as any),
      applyIncrementalFn: async (_e: any, repo: string) => {
        appliedRepo = repo;
        return { built: true, complete: true, chunk_count: 0, indexed_files: 0, total_files: 0 };
      },
    });
    const body = await res.json<any>();
    expect(body.action).toBe("indexing");
    // The repo passed down to the indexer (the manifest key) must be canonical.
    expect(appliedRepo).toBe("idoz-h/foo");
    expect(body.repo).toBe("idoz-h/foo");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleGitHubWebhook } from "../../src/handlers/github";
import { applyIncremental } from "../../src/pipeline/code-index";
import { getIndexManifest, putIndexManifest } from "../../src/lib/kv";
import { CHUNKER_VERSION } from "../../src/lib/chunker";
import * as vecStub from "../stubs/vectorize";

// The project has no vectorize alias — Miniflare has no AI/Vectorize emulation —
// so inject the in-memory stub as the vec backend while exercising the REAL
// applyIncremental + Miniflare KV manifest update.
const applyWithStubVec: typeof applyIncremental = (e, repo, gh, changed, removed, deps) =>
  applyIncremental(e, repo, gh, changed, removed, { ...deps, vec: vecStub });

const SECRET = "gh-secret";
const REPO = "o/r";

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

// Fake gh injected via deps.buildGh — exercises the real applyIncremental/KV/
// vectorize-stub path without real GitHub HTTP.
function fakeGh(tree: Array<{ path: string; sha: string }>) {
  return {
    getRepoTreeDetailed: async () => tree,
    getRepoTree: async () => tree.map((t) => t.path),
    readFile: async (_r: string, path: string) => ({ path, content: `code for ${path}\n`.repeat(3), size_bytes: 40, truncated: false }),
  } as any;
}

const basePayload = (over: any = {}) => ({
  ref: "refs/heads/main",
  after: "newhead",
  repository: { full_name: REPO, default_branch: "main" },
  commits: [{ added: [], modified: ["src/a.ts"], removed: ["src/gone.ts"] }],
  ...over,
});

beforeEach(async () => {
  (env as any).GITHUB_WEBHOOK_SECRET = SECRET;
  vecStub.__resetVectorizeStub();
  delete (env as any).CODE_INDEX;
  // Seed a semantic-enabled client mapping the pushed repo.
  await (env as any).CLIENTS.put("100", JSON.stringify({
    name: "Acme", telegram_chat_id: 100, active: true, created_at: "2026-05-01T00:00:00Z",
    projects: [{ id: "r", name_he: "R", repo: REPO, created_at: "x", semantic_enabled: true }],
    active_project_id: "r", default_project_id: "r",
  }));
  // Seed a complete manifest with a sha baseline.
  await putIndexManifest(env as any, REPO, {
    repo: REPO, fetched_at: "2026-05-01T00:00:00.000Z", chunk_count: 2, chunker_version: CHUNKER_VERSION,
    status: "complete", cursor: 2, paths: ["src/a.ts", "src/gone.ts"],
    file_shas: { "src/a.ts": "olda", "src/gone.ts": "oldg" },
    file_chunks: { "src/a.ts": [1], "src/gone.ts": [1] },
  });
});

describe("push webhook (integration)", () => {
  it("embeds the changed file, deletes the removed file's vectors, and updates the manifest", async () => {
    const deleted: string[] = [];
    (env as any).CODE_INDEX = { deleteByIds: async (ids: string[]) => { deleted.push(...ids); } };
    const gh = fakeGh([{ path: "src/a.ts", sha: "newa" }]); // gone.ts removed from the tree

    const res = await handleGitHubWebhook(await pushReq(basePayload()), env as any, undefined, {
      buildGh: async () => gh,
      applyIncrementalFn: applyWithStubVec,
    });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).action).toBe("indexing");

    // a.ts re-embedded into the (stub) vector store.
    expect(vecStub.__getVectorizeStubState().stored.some((s) => s.path === "src/a.ts")).toBe(true);
    // gone.ts vectors deleted via its stored chunk start lines.
    expect(deleted).toEqual(["o/r:src/gone.ts:1"]);

    const m = await getIndexManifest(env as any, REPO);
    expect(m!.file_shas).toEqual({ "src/a.ts": "newa" }); // a updated, gone dropped
    expect(m!.file_chunks!["src/gone.ts"]).toBeUndefined();
    expect(m!.head_sha).toBe("newhead");
    expect(m!.fetched_at).toBe("2026-05-01T00:00:00.000Z"); // untouched
  });

  it("ignores a push to a non-default branch and leaves the manifest unchanged", async () => {
    const before = await getIndexManifest(env as any, REPO);
    const res = await handleGitHubWebhook(await pushReq(basePayload({ ref: "refs/heads/dev" })), env as any, undefined, {
      buildGh: async () => { throw new Error("should not build gh for ignored push"); },
    });
    expect((await res.json<any>()).action).toBe("ignored");
    const after = await getIndexManifest(env as any, REPO);
    expect(after).toEqual(before);
  });
});

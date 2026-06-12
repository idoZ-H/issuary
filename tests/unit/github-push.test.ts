import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { filesFromPush, handleGitHubWebhook } from "../../src/handlers/github";

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

// A ctx whose waitUntil collects promises so the test can await background work.
function collectingCtx() {
  const pending: Promise<any>[] = [];
  return { ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any, settle: () => Promise.all(pending) };
}

beforeEach(() => {
  (env as any).GITHUB_WEBHOOK_SECRET = SECRET;
});

describe("filesFromPush", () => {
  it("unions added/modified/removed across commits, dedupes, flags truncation", () => {
    const payload = { ref: "refs/heads/main", commits: [
      { added: ["a.ts"], modified: ["b.ts"], removed: [] },
      { added: [], modified: ["b.ts"], removed: ["c.ts"] },
    ] };
    expect(filesFromPush(payload as any)).toEqual({ changed: ["a.ts", "b.ts"], removed: ["c.ts"], ref: "refs/heads/main", truncated: false });
  });

  it("classifies a path present in both modified and removed as removed", () => {
    const payload = { ref: "refs/heads/main", commits: [{ added: [], modified: ["x.ts"], removed: ["x.ts"] }] };
    expect(filesFromPush(payload as any)).toEqual({ changed: [], removed: ["x.ts"], ref: "refs/heads/main", truncated: false });
  });

  it("flags truncation at >= 20 commits", () => {
    const commits = Array.from({ length: 20 }, () => ({ added: [], modified: [], removed: [] }));
    expect(filesFromPush({ ref: "refs/heads/main", commits } as any).truncated).toBe(true);
  });
});

describe("push webhook branch", () => {
  const repoPayload = (over: any = {}) => ({
    ref: "refs/heads/main",
    after: "headsha",
    repository: { full_name: "x/y", default_branch: "main" },
    commits: [{ added: ["src/a.ts"], modified: [], removed: ["src/gone.ts"] }],
    ...over,
  });

  const semanticDeps = (over: any = {}) => ({
    listClientsFn: async () => [{ tg_user_id: 1, record: { projects: [{ repo: "x/y", semantic_enabled: true }] } } as any],
    buildGh: async () => ({} as any),
    ...over,
  });

  it("ignores pushes to non-default branches", async () => {
    const res = await handleGitHubWebhook(await pushReq(repoPayload({ ref: "refs/heads/feature" })), env as any, undefined, semanticDeps());
    expect(res.status).toBe(200);
    expect((await res.json<any>()).action).toBe("ignored");
  });

  it("ignores branch deletes", async () => {
    const res = await handleGitHubWebhook(await pushReq(repoPayload({ deleted: true })), env as any, undefined, semanticDeps());
    expect((await res.json<any>()).action).toBe("ignored");
  });

  it("ignores repos with no semantic-enabled project", async () => {
    const res = await handleGitHubWebhook(await pushReq(repoPayload()), env as any, undefined, semanticDeps({
      listClientsFn: async () => [{ tg_user_id: 1, record: { projects: [{ repo: "x/y", semantic_enabled: false }] } } as any],
    }));
    expect((await res.json<any>()).action).toBe("ignored");
  });

  it("runs applyIncremental inline for a small change set", async () => {
    const calls: any[] = [];
    const { ctx, settle } = collectingCtx();
    const res = await handleGitHubWebhook(await pushReq(repoPayload()), env as any, ctx, semanticDeps({
      applyIncrementalFn: async (_e: any, repo: string, _gh: any, changed: string[], removed: string[]) => {
        calls.push({ repo, changed, removed });
        return {} as any;
      },
    }));
    await settle();
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ repo: "x/y", changed: ["src/a.ts"], removed: ["src/gone.ts"] }]);
  });

  it("falls back to the blob-SHA diff (continueIndexBuild) on a truncated payload", async () => {
    const continued: string[] = [];
    const { ctx, settle } = collectingCtx();
    const manyCommits = Array.from({ length: 20 }, (_, i) => ({ added: [`f${i}.ts`], modified: [], removed: [] }));
    await handleGitHubWebhook(await pushReq(repoPayload({ commits: manyCommits })), env as any, ctx, semanticDeps({
      applyIncrementalFn: async () => { throw new Error("should not run inline"); },
      continueIndexBuildFn: async (_req: any, _env: any, repo: string) => { continued.push(repo); },
    }));
    await settle();
    expect(continued).toEqual(["x/y"]);
  });

  it("falls back to the diff on a forced push", async () => {
    const continued: string[] = [];
    const { ctx, settle } = collectingCtx();
    await handleGitHubWebhook(await pushReq(repoPayload({ forced: true })), env as any, ctx, semanticDeps({
      applyIncrementalFn: async () => { throw new Error("should not run inline"); },
      continueIndexBuildFn: async (_req: any, _env: any, repo: string) => { continued.push(repo); },
    }));
    await settle();
    expect(continued).toEqual(["x/y"]);
  });
});

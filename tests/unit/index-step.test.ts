import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { handleIndexStep, INDEX_STEP_PATH } from "../../src/handlers/index-step";
import type { EnsureIndexResult } from "../../src/pipeline/code-index";

// Minimal fake ExecutionContext that collects and runs waitUntil promises.
function makeCtx(): { ctx: ExecutionContext; drain: () => Promise<void> } {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as any;
  return { ctx, drain: () => Promise.all(waits).then(() => undefined) };
}

const SECRET = "test-secret-xyz";

function makeEnv() {
  return { ...env, TELEGRAM_WEBHOOK_SECRET: SECRET } as any;
}

function postReq(body: unknown, secret?: string): Request {
  return new Request(`https://worker.example.com${INDEX_STEP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret !== undefined ? { "X-Internal-Secret": secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

function completeResult(overrides: Partial<EnsureIndexResult> = {}): EnsureIndexResult {
  return {
    built: true,
    complete: true,
    chunk_count: 300,
    indexed_files: 300,
    total_files: 300,
    ...overrides,
  };
}

function incompleteResult(overrides: Partial<EnsureIndexResult> = {}): EnsureIndexResult {
  return {
    built: true,
    complete: false,
    chunk_count: 23,
    indexed_files: 15,
    total_files: 300,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: 401 on missing / wrong secret
// ---------------------------------------------------------------------------
describe("handleIndexStep", () => {
  it("returns 401 when X-Internal-Secret header is absent", async () => {
    const tenv = makeEnv();
    const { ctx } = makeCtx();
    let ensureCalled = false;
    const req = new Request(`https://worker.example.com${INDEX_STEP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "a/b" }),
    });
    const res = await handleIndexStep(req, tenv, ctx, {
      buildGh: async () => ({} as any),
      ensureFreshIndexFn: async () => { ensureCalled = true; return completeResult(); },
      fetcher: async () => new Response("ok"),
    });
    expect(res.status).toBe(401);
    expect(ensureCalled).toBe(false);
  });

  it("returns 401 when X-Internal-Secret header is wrong", async () => {
    const tenv = makeEnv();
    const { ctx } = makeCtx();
    let ensureCalled = false;
    const req = postReq({ repo: "a/b" }, "wrong-secret");
    const res = await handleIndexStep(req, tenv, ctx, {
      buildGh: async () => ({} as any),
      ensureFreshIndexFn: async () => { ensureCalled = true; return completeResult(); },
      fetcher: async () => new Response("ok"),
    });
    expect(res.status).toBe(401);
    expect(ensureCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 2: Runs one slice and fires continuation when not complete
  // -------------------------------------------------------------------------
  it("runs one slice, returns progress JSON, and fires continuation when incomplete", async () => {
    const tenv = makeEnv();
    const { ctx, drain } = makeCtx();
    const fetchCalls: { url: string; body: unknown; secret: string | null }[] = [];

    const req = postReq({ repo: "a/b" }, SECRET);
    const res = await handleIndexStep(req, tenv, ctx, {
      buildGh: async () => ({} as any),
      ensureFreshIndexFn: async () => incompleteResult(),
      fetcher: async (url, init) => {
        const body = init?.body ? JSON.parse(init.body as string) : null;
        const secret = (init?.headers as Record<string, string>)?.["X-Internal-Secret"] ?? null;
        fetchCalls.push({ url: url.toString(), body, secret });
        return new Response("ok");
      },
    });

    // Drain waitUntil promises so the self-fetch fires synchronously in test.
    await drain();

    expect(res.status).toBe(200);
    const j = await res.json<any>();
    expect(j.indexed).toBe(15);
    expect(j.total).toBe(300);
    expect(j.complete).toBe(false);

    // Exactly one self-fetch call was made.
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0]!;
    expect(call.url).toContain(INDEX_STEP_PATH);
    expect(call.body).toEqual({ repo: "a/b", hop: 1 });
    expect(call.secret).toBe(SECRET);
  });

  // -------------------------------------------------------------------------
  // Test 3: Stops chaining when complete
  // -------------------------------------------------------------------------
  it("does NOT fire continuation when build is complete", async () => {
    const tenv = makeEnv();
    const { ctx, drain } = makeCtx();
    let fetchCalled = false;

    const req = postReq({ repo: "a/b" }, SECRET);
    await handleIndexStep(req, tenv, ctx, {
      buildGh: async () => ({} as any),
      ensureFreshIndexFn: async () => completeResult(),
      fetcher: async () => { fetchCalled = true; return new Response("ok"); },
    });
    await drain();

    expect(fetchCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 4: Respects MAX_HOPS (40)
  // -------------------------------------------------------------------------
  it("does NOT fire continuation when hop+1 >= MAX_HOPS (hop=39)", async () => {
    const tenv = makeEnv();
    const { ctx, drain } = makeCtx();
    let fetchCalled = false;

    const req = postReq({ repo: "a/b", hop: 39 }, SECRET);
    await handleIndexStep(req, tenv, ctx, {
      buildGh: async () => ({} as any),
      ensureFreshIndexFn: async () => incompleteResult(),
      fetcher: async () => { fetchCalled = true; return new Response("ok"); },
    });
    await drain();

    expect(fetchCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 5: Missing repo → 400
  // -------------------------------------------------------------------------
  it("returns 400 when repo is missing from body", async () => {
    const tenv = makeEnv();
    const { ctx } = makeCtx();

    const req = postReq({}, SECRET);
    const res = await handleIndexStep(req, tenv, ctx, {
      buildGh: async () => ({} as any),
      ensureFreshIndexFn: async () => completeResult(),
      fetcher: async () => new Response("ok"),
    });

    expect(res.status).toBe(400);
    const j = await res.json<any>();
    expect(j.error).toBe("missing repo");
  });

  // -------------------------------------------------------------------------
  // Test 6 (optional): Build error is swallowed → 200, no continuation
  // -------------------------------------------------------------------------
  it("swallows build errors and returns 200 without continuation", async () => {
    const tenv = makeEnv();
    const { ctx, drain } = makeCtx();
    let fetchCalled = false;

    const req = postReq({ repo: "a/b" }, SECRET);
    const res = await handleIndexStep(req, tenv, ctx, {
      buildGh: async () => ({} as any),
      ensureFreshIndexFn: async () => { throw new Error("vectorize unreachable"); },
      fetcher: async () => { fetchCalled = true; return new Response("ok"); },
    });
    await drain();

    expect(res.status).toBe(200);
    const j = await res.json<any>();
    expect(j.error).toBe("build_failed");
    expect(fetchCalled).toBe(false);
  });
});

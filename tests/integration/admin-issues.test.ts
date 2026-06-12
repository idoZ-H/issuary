import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import { putAdmin, putClient, putIssueChat } from "../../src/lib/kv";

beforeEach(async () => {
  (env as any).TELEGRAM_BOT_TOKEN = "tt";
  await putAdmin(env as any, 100);
});

function stubFetch() {
  const calls: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    return new Response("", { status: 200 });
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function loginAsAdmin(): Promise<string> {
  const { calls, restore } = stubFetch();
  try {
    await worker.fetch(new Request("https://w/admin/login", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "tg_user_id=100",
    }), env as any, {} as any);
    const token = (calls[0].body.text as string).match(/t=([a-f0-9]+)/)![1];
    const cb = await worker.fetch(new Request(`https://w/admin/callback?t=${token}`), env as any, {} as any);
    return cb.headers.get("set-cookie")!.match(/admin_session=([a-f0-9]+);/)![1]!;
  } finally { restore(); }
}

describe("/admin/issues feed", () => {
  it("renders empty state when no issues exist", async () => {
    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/issues", {
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/no issues yet/);
  });

  it("lists seeded issues with client + project resolution", async () => {
    // Seed a client and three issue mappings on its repo.
    await putClient(env as any, 500, {
      name: "Alice", telegram_chat_id: 500, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "alpha", name_he: "Alpha", repo: "org/alpha", created_at: "2026-01-01T00:00:00Z" }],
      active_project_id: "alpha", default_project_id: "alpha",
    });
    await putIssueChat(env as any, "org/alpha", 1, { tg_user_id: 500, telegram_chat_id: 500 });
    await putIssueChat(env as any, "org/alpha", 2, { tg_user_id: 500, telegram_chat_id: 500 });
    await putIssueChat(env as any, "org/alpha", 3, { tg_user_id: 500, telegram_chat_id: 500 });

    const sid = await loginAsAdmin();

    // Inject a deterministic fetcher so we don't hit GitHub.
    // Worker dispatch uses the default fetcher path; for unit-level coverage
    // of the renderer with a stubbed fetcher, we hit renderIssuesFeed directly.
    // Here we go via Worker.fetch and rely on the GitHub call failing (no app
    // installation token configured) — the renderer should still emit rows
    // with the ⚠ stale marker.
    const res = await worker.fetch(new Request("https://w/admin/issues", {
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Alice/);
    expect(html).toMatch(/alpha/);
    // Three issue rows seeded.
    const rowMatches = html.match(/⚠ stale/g);
    expect(rowMatches?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("filters by client query param", async () => {
    await putClient(env as any, 500, {
      name: "Alice", telegram_chat_id: 500, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "alpha", name_he: "Alpha", repo: "org/alpha", created_at: "2026-01-01T00:00:00Z" }],
      active_project_id: "alpha", default_project_id: "alpha",
    });
    await putClient(env as any, 600, {
      name: "Bob", telegram_chat_id: 600, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "beta", name_he: "Beta", repo: "org/beta", created_at: "2026-01-01T00:00:00Z" }],
      active_project_id: "beta", default_project_id: "beta",
    });
    await putIssueChat(env as any, "org/alpha", 1, { tg_user_id: 500, telegram_chat_id: 500 });
    await putIssueChat(env as any, "org/beta", 1, { tg_user_id: 600, telegram_chat_id: 600 });

    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/issues?client=500", {
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Alice/);
    expect(html).not.toMatch(/>Bob</);
  });

  it("shows langsmith trace link when run_id is present + LANGSMITH_ORG_SLUG is set", async () => {
    (env as any).LANGSMITH_ORG_SLUG = "test-org";
    await putClient(env as any, 500, {
      name: "Alice", telegram_chat_id: 500, active: true, created_at: "2026-01-01T00:00:00Z",
      projects: [{ id: "alpha", name_he: "Alpha", repo: "org/alpha", created_at: "2026-01-01T00:00:00Z" }],
      active_project_id: "alpha", default_project_id: "alpha",
    });
    await putIssueChat(env as any, "org/alpha", 1, {
      tg_user_id: 500, telegram_chat_id: 500,
      langsmith_run_id: "abc-123",
    });

    const sid = await loginAsAdmin();
    const res = await worker.fetch(new Request("https://w/admin/issues", {
      headers: { cookie: `admin_session=${sid}` },
    }), env as any, {} as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/smith\.langchain\.com.*test-org.*abc-123/);
  });
});

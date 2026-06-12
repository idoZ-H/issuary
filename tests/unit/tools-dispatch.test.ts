import { describe, it, expect, vi } from "vitest";
import { ToolDispatcher } from "../../src/tools/dispatch";

const repo = "x/y";

function fakeGh(overrides: Partial<any> = {}) {
  return {
    searchCode: vi.fn(async () => ({ matches: [{ path: "a.ts", snippet: "x", url: "u" }], total: 1, truncated: false })),
    searchIssues: vi.fn(async () => ({ matches: [], total: 0, truncated: false })),
    readFile: vi.fn(async () => ({ path: "a.ts", content: "z", size_bytes: 1, truncated: false })),
    ...overrides,
  };
}

describe("ToolDispatcher", () => {
  it("dispatches a github_search_code call", async () => {
    const gh = fakeGh();
    const d = new ToolDispatcher(gh as any, repo, async () => {});
    const r = await d.dispatch({ name: "github_search_code", input: { query: "export" } });
    expect(r.is_error).toBe(false);
    expect(JSON.parse(r.content).matches[0].path).toBe("a.ts");
  });

  it("enforces the 4-tool-call budget", async () => {
    const gh = fakeGh();
    const d = new ToolDispatcher(gh as any, repo, async () => {});
    for (let i = 0; i < 4; i++) {
      const r = await d.dispatch({ name: "github_search_code", input: { query: "q" } });
      expect(r.is_error).toBe(false);
    }
    const r = await d.dispatch({ name: "github_search_code", input: { query: "q" } });
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/budget/i);
  });

  it("rejects a second ask_clarifying_question call", async () => {
    const sendQ = vi.fn(async () => {});
    const gh = fakeGh();
    const d = new ToolDispatcher(gh as any, repo, sendQ);
    const r1 = await d.dispatch({ name: "ask_clarifying_question", input: { question_he: "q?", reason_en: "r" } });
    expect(r1.is_error).toBe(false);
    expect(sendQ).toHaveBeenCalledOnce();
    const r2 = await d.dispatch({ name: "ask_clarifying_question", input: { question_he: "q2?", reason_en: "r2" } });
    expect(r2.is_error).toBe(true);
    expect(r2.content).toMatch(/already asked|budget exhausted/i);
    expect(sendQ).toHaveBeenCalledOnce();
  });

  it("returns an error result when a downstream tool throws", async () => {
    const gh = fakeGh({ searchCode: vi.fn(async () => { throw new Error("boom"); }) });
    const d = new ToolDispatcher(gh as any, repo, async () => {});
    const r = await d.dispatch({ name: "github_search_code", input: { query: "q" } });
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("boom");
  });

  it("merges semantic_matches into the result when retrieveActive returns chunks", async () => {
    const gh = fakeGh();
    const chunk = { path: "src/Foo.js", start_line: 10, end_line: 20, snippet: "...", score: 0.91 };
    const retrieveActive = vi.fn(async () => [chunk]);
    const d = new ToolDispatcher(gh as any, repo, async () => {}, undefined, retrieveActive);
    const r = await d.dispatch({ name: "github_search_code", input: { query: "Foo" } });
    expect(r.is_error).toBe(false);
    const parsed = JSON.parse(r.content);
    expect(parsed).toHaveProperty("github_search");
    expect(parsed).toHaveProperty("semantic_matches");
    expect(parsed.semantic_matches).toHaveLength(1);
    expect(parsed.semantic_matches[0].path).toBe("src/Foo.js");
    expect(parsed.semantic_matches[0].score).toBe(0.91);
    expect(parsed.github_search.matches[0].path).toBe("a.ts");
  });

  it("returns github-only shape when retrieveActive returns empty array", async () => {
    const gh = fakeGh();
    const retrieveActive = vi.fn(async () => []);
    const d = new ToolDispatcher(gh as any, repo, async () => {}, undefined, retrieveActive);
    const r = await d.dispatch({ name: "github_search_code", input: { query: "nothing" } });
    expect(r.is_error).toBe(false);
    const parsed = JSON.parse(r.content);
    // No semantic_matches key — same shape as the github-only result
    expect(parsed).not.toHaveProperty("semantic_matches");
    expect(parsed.matches[0].path).toBe("a.ts");
  });
});

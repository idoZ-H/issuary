import { describe, it, expect, vi } from "vitest";
import { ToolDispatcher, isLowGrounding } from "../../src/tools/dispatch";

const repo = "x/y";

describe("isLowGrounding", () => {
  it("flags when github found nothing and the top semantic score is weak", () => {
    expect(isLowGrounding({ github_search_calls: 2, github_total_matches: 0, semantic_calls: 2, top_semantic_score: 0.12 })).toBe(true);
  });
  it("does not flag when github code search returned matches", () => {
    expect(isLowGrounding({ github_search_calls: 1, github_total_matches: 3, semantic_calls: 1, top_semantic_score: 0.1 })).toBe(false);
  });
  it("does not flag when a strong semantic match exists", () => {
    expect(isLowGrounding({ github_search_calls: 1, github_total_matches: 0, semantic_calls: 1, top_semantic_score: 0.9 })).toBe(false);
  });
  it("does not flag when the model never searched the code", () => {
    expect(isLowGrounding({ github_search_calls: 0, github_total_matches: 0, semantic_calls: 0, top_semantic_score: null })).toBe(false);
  });
});

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

  it("uses semantic_query (HyDE NL hypothesis) for retrieval but query for GitHub code search", async () => {
    const gh = fakeGh();
    const retrieveActive = vi.fn(async () => []);
    const d = new ToolDispatcher(gh as any, repo, async () => {}, undefined, retrieveActive);
    await d.dispatch({
      name: "github_search_code",
      input: { query: "agency token", semantic_query: "where the WhatsApp agency-quote message is sent to the group" },
    });
    expect(retrieveActive).toHaveBeenCalledWith("where the WhatsApp agency-quote message is sent to the group");
    expect(gh.searchCode).toHaveBeenCalledWith(repo, "agency token");
  });

  it("falls back to query for retrieval when semantic_query is absent", async () => {
    const gh = fakeGh();
    const retrieveActive = vi.fn(async () => []);
    const d = new ToolDispatcher(gh as any, repo, async () => {}, undefined, retrieveActive);
    await d.dispatch({ name: "github_search_code", input: { query: "export button" } });
    expect(retrieveActive).toHaveBeenCalledWith("export button");
  });

  it("accumulates grounding stats across github_search_code calls", async () => {
    const gh = fakeGh({ searchCode: vi.fn(async () => ({ matches: [], total: 0, truncated: false })) });
    const chunks = [
      { path: "src/Foo.js", start_line: 10, end_line: 20, snippet: "...", score: 0.42 },
      { path: "src/Bar.js", start_line: 1, end_line: 5, snippet: "...", score: 0.81 },
    ];
    const retrieveActive = vi.fn(async () => chunks);
    const d = new ToolDispatcher(gh as any, repo, async () => {}, undefined, retrieveActive);
    await d.dispatch({ name: "github_search_code", input: { query: "Foo" } });
    const g = d.getGrounding();
    expect(g.github_search_calls).toBe(1);
    expect(g.github_total_matches).toBe(0);
    expect(g.semantic_calls).toBe(1);
    expect(g.top_semantic_score).toBeCloseTo(0.81, 5); // max across the call's chunks
  });

  it("reports a null top_semantic_score when no semantic retrieval ran", async () => {
    const gh = fakeGh();
    const d = new ToolDispatcher(gh as any, repo, async () => {});
    await d.dispatch({ name: "github_search_code", input: { query: "x" } });
    const g = d.getGrounding();
    expect(g.github_search_calls).toBe(1);
    expect(g.github_total_matches).toBe(1);
    expect(g.semantic_calls).toBe(0);
    expect(g.top_semantic_score).toBeNull();
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

import { describe, it, expect, vi } from "vitest";
import { ToolDispatcher } from "../../src/tools/dispatch";

const fakeGh = () =>
  ({
    searchCode: vi.fn(async (_repo: string, _q: string) => ({
      matches: [{ path: "src/Dashboard.tsx", snippet: "export button", url: "u" }],
      total: 1,
      truncated: false,
    })),
    searchIssues: vi.fn(async () => ({ matches: [], total: 0, truncated: false })),
    readFile: vi.fn(async () => ({ path: "x", content: "", size_bytes: 0, truncated: false })),
  }) as any;

const noopClarify = async () => {};

describe("ToolDispatcher shadow retrieval", () => {
  it("returns the real github_search_code result unchanged and fires shadowRetrieve once", async () => {
    const gh = fakeGh();
    const shadowRetrieve = vi.fn();
    const d = new ToolDispatcher(gh, "acme/widget", noopClarify, shadowRetrieve);

    const res = await d.dispatch({ name: "github_search_code", input: { query: "export button" } });

    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).matches[0].path).toBe("src/Dashboard.tsx");
    expect(shadowRetrieve).toHaveBeenCalledTimes(1);
    expect(shadowRetrieve).toHaveBeenCalledWith("export button");
  });

  it("never lets a shadowRetrieve error affect the live result", async () => {
    const gh = fakeGh();
    const shadowRetrieve = vi.fn(() => {
      throw new Error("shadow boom");
    });
    const d = new ToolDispatcher(gh, "acme/widget", noopClarify, shadowRetrieve);

    const res = await d.dispatch({ name: "github_search_code", input: { query: "x" } });
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).total).toBe(1);
  });

  it("behaves identically when no shadowRetrieve is provided", async () => {
    const gh = fakeGh();
    const d = new ToolDispatcher(gh, "acme/widget", noopClarify);
    const res = await d.dispatch({ name: "github_search_code", input: { query: "x" } });
    expect(res.is_error).toBe(false);
    expect(gh.searchCode).toHaveBeenCalledTimes(1);
  });

  it("does not fire shadowRetrieve for non-search tools", async () => {
    const gh = fakeGh();
    const shadowRetrieve = vi.fn();
    const d = new ToolDispatcher(gh, "acme/widget", noopClarify, shadowRetrieve);
    await d.dispatch({ name: "github_search_issues", input: { query: "x", state: "open" } });
    expect(shadowRetrieve).not.toHaveBeenCalled();
  });
});

describe("ToolDispatcher active semantic retrieval", () => {
  it("injects semantic_matches when retrieveActive returns chunks", async () => {
    const gh = fakeGh();
    const chunks = [{ path: "src/auth.ts", start_line: 1, end_line: 9, snippet: "function login()", score: 0.9 }];
    const retrieveActive = vi.fn(async () => chunks);
    const d = new ToolDispatcher(gh, "acme/widget", noopClarify, undefined, retrieveActive);

    const res = await d.dispatch({ name: "github_search_code", input: { query: "login" } });

    expect(res.is_error).toBe(false);
    const parsed = JSON.parse(res.content);
    expect(parsed.github_search.matches[0].path).toBe("src/Dashboard.tsx");
    expect(parsed.semantic_matches).toEqual(chunks);
    expect(retrieveActive).toHaveBeenCalledWith("login");
  });

  it("omits semantic_matches and returns the raw github result when retrieveActive yields []", async () => {
    const gh = fakeGh();
    const retrieveActive = vi.fn(async () => []);
    const d = new ToolDispatcher(gh, "acme/widget", noopClarify, undefined, retrieveActive);

    const res = await d.dispatch({ name: "github_search_code", input: { query: "login" } });

    const parsed = JSON.parse(res.content);
    expect(parsed.semantic_matches).toBeUndefined();
    expect(parsed.matches[0].path).toBe("src/Dashboard.tsx");
  });

  it("falls back to the github result when retrieveActive throws", async () => {
    const gh = fakeGh();
    const retrieveActive = vi.fn(async () => { throw new Error("vec boom"); });
    const d = new ToolDispatcher(gh, "acme/widget", noopClarify, undefined, retrieveActive);

    const res = await d.dispatch({ name: "github_search_code", input: { query: "login" } });
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).total).toBe(1);
  });
});

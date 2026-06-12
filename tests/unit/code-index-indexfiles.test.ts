import { describe, it, expect } from "vitest";
import { indexFiles } from "../../src/pipeline/code-index";

const vec = {
  embedTexts: async (_e: any, t: string[]) => t.map(() => [0.1]),
  upsertChunks: async () => {},
  queryChunks: async () => [],
};

function ghReading(files: Record<string, string>): any {
  return {
    readFile: async (_r: string, p: string) => {
      const content = files[p] ?? "";
      return { path: p, content, size_bytes: content.length, truncated: false };
    },
    getRepoTree: async () => [],
    getRepoTreeDetailed: async () => [],
  };
}

describe("indexFiles", () => {
  it("indexes given files and reports per-file chunk start lines", async () => {
    const gh = ghReading({ "a.ts": "x\n".repeat(80) });
    const out = await indexFiles({} as any, "o/r", ["a.ts"], gh, { vec });
    expect(out.chunksAdded).toBeGreaterThan(0);
    expect(out.perFileStartLines["a.ts"]![0]).toBe(1);
  });

  it("skips unreadable/empty files (no start lines recorded)", async () => {
    const gh = ghReading({ "a.ts": "code\n".repeat(80) }); // "missing.ts" reads empty
    const out = await indexFiles({} as any, "o/r", ["a.ts", "missing.ts"], gh, { vec });
    expect(out.perFileStartLines["missing.ts"]).toBeUndefined();
    expect(out.perFileStartLines["a.ts"]).toBeDefined();
  });

  it("skips oversized files", async () => {
    const gh = ghReading({ "big.ts": "x\n".repeat(80) });
    const out = await indexFiles({} as any, "o/r", ["big.ts"], gh, { vec, maxFileBytes: 10 });
    expect(out.chunksAdded).toBe(0);
    expect(out.perFileStartLines["big.ts"]).toBeUndefined();
  });

  it("honors the maxChunks budget passed via deps", async () => {
    const gh = ghReading({ "a.ts": "x\n".repeat(400), "b.ts": "y\n".repeat(400) });
    const out = await indexFiles({} as any, "o/r", ["a.ts", "b.ts"], gh, { vec, maxChunks: 2 });
    expect(out.chunksAdded).toBe(2);
  });
});

import { describe, it, expect } from "vitest";
import { LineWindowChunker, CHUNKER_VERSION, type CodeChunk } from "../../src/lib/chunker";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("LineWindowChunker", () => {
  const chunker = new LineWindowChunker(); // window 60, overlap 15

  it("exposes the chunker version", () => {
    expect(chunker.version).toBe(CHUNKER_VERSION);
  });

  it("returns [] for empty content", () => {
    expect(chunker.chunk("", "a.ts")).toEqual([]);
    expect(chunker.chunk("   \n  \n", "a.ts")).toEqual([]);
  });

  it("returns a single whole-file chunk when shorter than the window", () => {
    const content = lines(10);
    const chunks = chunker.chunk(content, "small.ts");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject<Partial<CodeChunk>>({
      path: "small.ts",
      start_line: 1,
      end_line: 10,
    });
    expect(chunks[0]!.text).toBe(content);
  });

  it("splits a long file into multiple windowed chunks", () => {
    const chunks = chunker.chunk(lines(200), "big.ts");
    expect(chunks.length).toBeGreaterThan(1);
    // each chunk spans at most `window` lines
    for (const c of chunks) {
      expect(c.end_line - c.start_line + 1).toBeLessThanOrEqual(60);
      expect(c.path).toBe("big.ts");
    }
  });

  it("overlaps consecutive chunks by the configured overlap", () => {
    const chunks = chunker.chunk(lines(200), "big.ts");
    // step = window - overlap = 45, so chunk 2 starts at line 46
    expect(chunks[0]!.start_line).toBe(1);
    expect(chunks[0]!.end_line).toBe(60);
    expect(chunks[1]!.start_line).toBe(46);
    // overlap region is lines 46..60 (15 lines) shared with chunk 0
    expect(chunks[1]!.start_line).toBeLessThanOrEqual(chunks[0]!.end_line);
  });

  it("uses 1-based inclusive line numbers covering the whole file", () => {
    const chunks = chunker.chunk(lines(200), "big.ts");
    expect(chunks[0]!.start_line).toBe(1);
    expect(chunks[chunks.length - 1]!.end_line).toBe(200);
  });

  it("honors a custom window and overlap", () => {
    const custom = new LineWindowChunker(10, 2); // step = 8
    const chunks = custom.chunk(lines(30), "c.ts");
    expect(chunks[0]).toMatchObject({ start_line: 1, end_line: 10 });
    expect(chunks[1]).toMatchObject({ start_line: 9, end_line: 18 });
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { deleteFileVectors, chunkId } from "../../src/lib/vectorize";

describe("deleteFileVectors", () => {
  it("deletes the derived chunk ids for a file", async () => {
    const deleted: string[] = [];
    (env as any).CODE_INDEX = { deleteByIds: async (ids: string[]) => { deleted.push(...ids); } };
    await deleteFileVectors(env as any, "o/r", "src/a.ts", [1, 46]);
    expect(deleted).toEqual([await chunkId("o/r", "src/a.ts", 1), await chunkId("o/r", "src/a.ts", 46)]);
  });

  it("is a no-op when there are no start lines", async () => {
    let called = false;
    (env as any).CODE_INDEX = { deleteByIds: async () => { called = true; } };
    await deleteFileVectors(env as any, "o/r", "src/a.ts", []);
    expect(called).toBe(false);
  });
});

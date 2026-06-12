import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { putIndexManifest, getIndexManifest, deleteIndexManifest } from "../../src/lib/kv";

describe("deleteIndexManifest", () => {
  it("removes a stored manifest", async () => {
    const m = { repo: "o/r", fetched_at: "2026-06-05T00:00:00Z", chunk_count: 3, chunker_version: "linewin-v2", status: "complete" as const, cursor: 5, paths: ["a", "b", "c", "d", "e"] };
    await putIndexManifest(env as any, "o/r", m);
    expect(await getIndexManifest(env as any, "o/r")).not.toBeNull();
    await deleteIndexManifest(env as any, "o/r");
    expect(await getIndexManifest(env as any, "o/r")).toBeNull();
  });
});

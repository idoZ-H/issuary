import { describe, it, expect } from "vitest";
import { deriveIndexState, collectIndexStatuses } from "../../src/admin/index-status";
import type { CodeIndexManifest } from "../../src/types";

const VER = "linewin-v2";
const NOW = Date.parse("2026-06-05T00:00:00Z");
const complete = (over: Partial<CodeIndexManifest> = {}): CodeIndexManifest => ({
  repo: "o/r", fetched_at: "2026-06-05T00:00:00Z", chunk_count: 10, chunker_version: VER,
  status: "complete", cursor: 5, paths: ["a", "b", "c", "d", "e"], ...over,
});

describe("deriveIndexState", () => {
  it("disabled when semantic off", () => {
    expect(deriveIndexState(complete(), VER, NOW, false)).toBe("disabled");
  });
  it("missing when no manifest", () => {
    expect(deriveIndexState(null, VER, NOW, true)).toBe("missing");
  });
  it("building when status building", () => {
    expect(deriveIndexState(complete({ status: "building", cursor: 2 }), VER, NOW, true)).toBe("building");
  });
  it("complete when fresh", () => {
    expect(deriveIndexState(complete(), VER, NOW, true)).toBe("complete");
  });
  it("stale when TTL expired", () => {
    const old = "2026-05-01T00:00:00Z";
    expect(deriveIndexState(complete({ fetched_at: old }), VER, NOW, true)).toBe("stale");
  });
  it("stale when chunker version mismatch", () => {
    expect(deriveIndexState(complete({ chunker_version: "old" }), VER, NOW, true)).toBe("stale");
  });
});

describe("collectIndexStatuses", () => {
  it("groups repos across clients and derives rows, building first", async () => {
    const listClients = async () => [
      { tg_user_id: 1, record: { name: "A", projects: [{ id: "p1", name_he: "P1", repo: "o/r1", created_at: "x", semantic_enabled: true }], active_project_id: "p1", default_project_id: "p1", telegram_chat_id: 1, active: true, created_at: "x" } },
      { tg_user_id: 2, record: { name: "B", projects: [{ id: "p2", name_he: "P2", repo: "o/r1", created_at: "x", semantic_enabled: true }], active_project_id: "p2", default_project_id: "p2", telegram_chat_id: 2, active: true, created_at: "x" } },
      { tg_user_id: 3, record: { name: "C", projects: [{ id: "p3", name_he: "P3", repo: "o/r2", created_at: "x", semantic_enabled: true }], active_project_id: "p3", default_project_id: "p3", telegram_chat_id: 3, active: true, created_at: "x" } },
    ];
    const manifests: Record<string, CodeIndexManifest> = {
      "o/r1": complete(),
      "o/r2": complete({ repo: "o/r2", status: "building", cursor: 1 }),
    };
    const rows = await collectIndexStatuses({} as any, {
      listClients: listClients as any,
      getManifest: async (_e, repo) => manifests[repo] ?? null,
      now: () => NOW,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.repo).toBe("o/r2");           // building sorts first
    expect(rows[0]!.state).toBe("building");
    const r1 = rows.find((r) => r.repo === "o/r1")!;
    expect(r1.clients).toHaveLength(2);          // two clients reference o/r1
    expect(r1.indexed_files).toBe(5);
    expect(r1.total_files).toBe(5);
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runIndexMaintenance, type IndexMaintenanceDeps } from "../../src/pipeline/index-maintenance";
import { putIndexManifest, putClient } from "../../src/lib/kv";
import { CHUNKER_VERSION } from "../../src/lib/chunker";
import type { EnsureIndexResult } from "../../src/pipeline/code-index";

const FIXED_NOW = new Date("2026-05-30T12:00:00Z").toISOString();
// Controlled "now" 1 minute after fetched_at, so a current-version complete
// manifest reads as fresh (age << TTL) deterministically, regardless of when
// the suite actually runs.
const NOW_FN = () => new Date(FIXED_NOW).getTime() + 60_000;

function buildingManifest(repo: string) {
  return {
    repo,
    fetched_at: FIXED_NOW,
    chunk_count: 0,
    chunker_version: CHUNKER_VERSION,
    status: "building" as const,
    cursor: 0,
    paths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
  };
}

function completeManifest(repo: string) {
  return {
    repo,
    fetched_at: FIXED_NOW,
    chunk_count: 10,
    chunker_version: CHUNKER_VERSION,
    status: "complete" as const,
    cursor: 5,
    paths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
  };
}

// A stub buildGh that never throws and returns a dummy client.
const noopBuildGh = async () => ({} as any);

describe("runIndexMaintenance", () => {
  it("advances a building repo up to MAX_SLICES_PER_TICK (2) per tick", async () => {
    const repo = "maint-test/alpha-advancing";
    await putIndexManifest(env as any, repo, buildingManifest(repo));

    const callsForRepo: string[] = [];
    const deps: IndexMaintenanceDeps = {
      buildGh: noopBuildGh,
      now: NOW_FN,
      ensureFreshIndexFn: async (_e, r, _gh) => {
        callsForRepo.push(r);
        // Always return building — never completes
        return { built: true, complete: false, chunk_count: 5, indexed_files: 5, total_files: 10 } satisfies EnsureIndexResult;
      },
    };

    await runIndexMaintenance(env as any, deps);

    // Filter to only this test's repo
    const myRepoCalls = callsForRepo.filter((r) => r === repo);
    // MAX_SLICES_PER_TICK = 2
    expect(myRepoCalls).toHaveLength(2);
  });

  it("stops early when a repo completes on the first slice", async () => {
    const repo = "maint-test/beta-completes-early";
    await putIndexManifest(env as any, repo, buildingManifest(repo));

    const callsForRepo: string[] = [];
    const deps: IndexMaintenanceDeps = {
      buildGh: noopBuildGh,
      now: NOW_FN,
      ensureFreshIndexFn: async (_e, r, _gh) => {
        callsForRepo.push(r);
        // Completes immediately on first call
        return { built: true, complete: true, chunk_count: 15, indexed_files: 5, total_files: 5 } satisfies EnsureIndexResult;
      },
    };

    await runIndexMaintenance(env as any, deps);

    const myRepoCalls = callsForRepo.filter((r) => r === repo);
    // Stops after the first call (complete: true)
    expect(myRepoCalls).toHaveLength(1);
  });

  it("stops early when a repo completes on the second slice", async () => {
    const repo = "maint-test/gamma-completes-second";
    await putIndexManifest(env as any, repo, buildingManifest(repo));

    let callCount = 0;
    const callsForRepo: string[] = [];
    const deps: IndexMaintenanceDeps = {
      buildGh: noopBuildGh,
      now: NOW_FN,
      ensureFreshIndexFn: async (_e, r, _gh) => {
        callCount++;
        callsForRepo.push(r);
        const complete = callCount >= 2;
        return { built: true, complete, chunk_count: 10, indexed_files: complete ? 5 : 2, total_files: 5 } satisfies EnsureIndexResult;
      },
    };

    await runIndexMaintenance(env as any, deps);

    const myRepoCalls = callsForRepo.filter((r) => r === repo);
    // Stops after 2 calls: first returns building, second returns complete → no 3rd call
    expect(myRepoCalls).toHaveLength(2);
  });

  it("skips repos whose manifest is already complete", async () => {
    const repo = "maint-test/delta-complete";
    await putIndexManifest(env as any, repo, completeManifest(repo));

    const callsForRepo: string[] = [];
    const deps: IndexMaintenanceDeps = {
      buildGh: noopBuildGh,
      now: NOW_FN,
      ensureFreshIndexFn: async (_e, r, _gh) => {
        callsForRepo.push(r);
        return { built: false, complete: true, chunk_count: 10, indexed_files: 5, total_files: 5 } satisfies EnsureIndexResult;
      },
    };

    await runIndexMaintenance(env as any, deps);

    const myRepoCalls = callsForRepo.filter((r) => r === repo);
    // Should never be called since manifest.status === "complete"
    expect(myRepoCalls).toHaveLength(0);
  });

  it("bootstraps an enabled project that has no manifest yet", async () => {
    await putClient(env as any, 9100, {
      name: "Fresh", telegram_chat_id: 9100, active: true, created_at: FIXED_NOW,
      projects: [{ id: "fresh", name_he: "F", repo: "maint-test/fresh-bootstrap", created_at: FIXED_NOW, semantic_enabled: true }],
      active_project_id: "fresh", default_project_id: "fresh",
    });
    const calls: string[] = [];
    await runIndexMaintenance(env as any, {
      buildGh: noopBuildGh, now: NOW_FN,
      ensureFreshIndexFn: async (_e, repo) => {
        calls.push(repo);
        return { built: true, complete: true, indexed_files: 1, total_files: 1, chunk_count: 1 } satisfies EnsureIndexResult;
      },
    });
    expect(calls).toContain("maint-test/fresh-bootstrap");
  });

  it("does not bootstrap a project with semantic_enabled false", async () => {
    await putClient(env as any, 9101, {
      name: "Off", telegram_chat_id: 9101, active: true, created_at: FIXED_NOW,
      projects: [{ id: "off", name_he: "O", repo: "maint-test/off-bootstrap", created_at: FIXED_NOW, semantic_enabled: false }],
      active_project_id: "off", default_project_id: "off",
    });
    const calls: string[] = [];
    await runIndexMaintenance(env as any, {
      buildGh: noopBuildGh, now: NOW_FN,
      ensureFreshIndexFn: async (_e, repo) => {
        calls.push(repo);
        return { built: true, complete: true, indexed_files: 1, total_files: 1, chunk_count: 1 } satisfies EnsureIndexResult;
      },
    });
    expect(calls).not.toContain("maint-test/off-bootstrap");
  });

  it("does not re-bootstrap an enabled project that already has a manifest", async () => {
    const repo = "maint-test/already-indexed";
    await putIndexManifest(env as any, repo, completeManifest(repo));
    await putClient(env as any, 9102, {
      name: "Done", telegram_chat_id: 9102, active: true, created_at: FIXED_NOW,
      projects: [{ id: "done", name_he: "D", repo, created_at: FIXED_NOW, semantic_enabled: true }],
      active_project_id: "done", default_project_id: "done",
    });
    const calls: string[] = [];
    await runIndexMaintenance(env as any, {
      buildGh: noopBuildGh, now: NOW_FN,
      ensureFreshIndexFn: async (_e, r) => { calls.push(r); return { built: false, complete: true, indexed_files: 5, total_files: 5, chunk_count: 10 } satisfies EnsureIndexResult; },
    });
    // Fresh complete manifest → neither the stale loop nor the bootstrap touches it.
    expect(calls.filter((r) => r === repo)).toHaveLength(0);
  });

  it("isolates buildGh failures: logs, continues, does not call ensureFreshIndexFn", async () => {
    const repo = "maint-test/epsilon-build-fails";
    await putIndexManifest(env as any, repo, buildingManifest(repo));

    const ensureCalls: string[] = [];
    const deps: IndexMaintenanceDeps = {
      buildGh: async (_e, r) => {
        if (r === repo) throw new Error("token fetch failed");
        return {} as any;
      },
      now: NOW_FN,
      ensureFreshIndexFn: async (_e, r, _gh) => {
        ensureCalls.push(r);
        return { built: true, complete: false, chunk_count: 5, indexed_files: 2, total_files: 5 } satisfies EnsureIndexResult;
      },
    };

    // Must not throw
    await expect(runIndexMaintenance(env as any, deps)).resolves.toBeUndefined();

    const myCalls = ensureCalls.filter((r) => r === repo);
    // ensureFreshIndexFn was never called for the failing repo
    expect(myCalls).toHaveLength(0);
  });
});

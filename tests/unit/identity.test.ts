import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resolveIdentity } from "../../src/pipeline/identity";

describe("resolveIdentity", () => {
  beforeEach(async () => {
    // Legacy shape — should be auto-migrated by getClient.
    await (env as any).CLIENTS.put("100", JSON.stringify({
      name: "Yossi", repo: "x/acme-core", telegram_chat_id: 100,
      active: true, created_at: "2026-04-29T00:00:00Z",
    }));
    await (env as any).CLIENTS.put("200", JSON.stringify({
      name: "OldClient", repo: "x/old", telegram_chat_id: 200,
      active: false, created_at: "2026-01-01T00:00:00Z",
    }));
  });

  it("resolves an active client and returns the active project", async () => {
    const r = await resolveIdentity(env as any, 100);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.record.name).toBe("Yossi");
      expect(r.project.repo).toBe("x/acme-core");
      expect(r.project.id).toBe("acme-core");
    }
  });

  it("rejects an inactive client", async () => {
    const r = await resolveIdentity(env as any, 200);
    expect(r.kind).toBe("inactive");
  });

  it("rejects an unknown user", async () => {
    const r = await resolveIdentity(env as any, 999);
    expect(r.kind).toBe("unknown");
  });
});

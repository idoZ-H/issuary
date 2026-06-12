import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { getHistory, appendTurn } from "../../src/lib/kv";

describe("conversation history KV helpers", () => {
  it("returns null when no history exists", async () => {
    const r = await getHistory(env as any, 700, "p1");
    expect(r).toBeNull();
  });

  it("appendTurn writes a single turn", async () => {
    await appendTurn(env as any, 701, "p1", { role: "user", text: "hello" });
    const h = await getHistory(env as any, 701, "p1");
    expect(h?.turns).toHaveLength(1);
    expect(h?.turns[0]?.role).toBe("user");
    expect(h?.turns[0]?.text).toBe("hello");
    expect(typeof h?.turns[0]?.ts).toBe("string");
    expect(typeof h?.updated_at).toBe("string");
  });

  it("appendTurn appends to existing history", async () => {
    await appendTurn(env as any, 702, "p1", { role: "user", text: "first" });
    await appendTurn(env as any, 702, "p1", { role: "assistant", text: "second" });
    const h = await getHistory(env as any, 702, "p1");
    expect(h?.turns).toHaveLength(2);
    expect(h?.turns[0]?.text).toBe("first");
    expect(h?.turns[1]?.text).toBe("second");
  });

  it("caps history at 5 turns (oldest dropped on append)", async () => {
    for (let i = 1; i <= 7; i++) {
      await appendTurn(env as any, 703, "p1", { role: "user", text: `msg${i}` });
    }
    const h = await getHistory(env as any, 703, "p1");
    expect(h?.turns).toHaveLength(5);
    expect(h?.turns[0]?.text).toBe("msg3");
    expect(h?.turns[4]?.text).toBe("msg7");
  });

  it("isolates history per project", async () => {
    await appendTurn(env as any, 704, "alpha", { role: "user", text: "in alpha" });
    await appendTurn(env as any, 704, "beta",  { role: "user", text: "in beta" });
    const a = await getHistory(env as any, 704, "alpha");
    const b = await getHistory(env as any, 704, "beta");
    expect(a?.turns).toHaveLength(1);
    expect(b?.turns).toHaveLength(1);
    expect(a?.turns[0]?.text).toBe("in alpha");
    expect(b?.turns[0]?.text).toBe("in beta");
  });
});

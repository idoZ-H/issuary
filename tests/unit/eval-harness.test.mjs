// CI regression gate for the retrieval eval harness.
//
// The LIVE retriever (Workers AI + Vectorize) can't run offline, so this gate
// does NOT measure real retrieval. It guards the *scoring pipeline*: the
// committed synthetic golden set (eval/golden-set.sample.json) must stay valid
// and must score at or above a fixed floor under eval/metrics.mjs. If someone
// breaks the metrics math or the fixture shape, `npm test` (CI) fails here —
// the cheap smoke check that prompt/retriever edits previously had no gate for.
import { describe, it, expect } from "vitest";
import { aggregate, recallAtK } from "../../eval/metrics.mjs";
// Static JSON import — bundled at transform time, so no runtime fs (the workerd
// test runtime has no readFileSync).
import parsed from "../../eval/golden-set.sample.json";

const RECALL_FLOOR = 0.8;

describe("eval harness regression gate", () => {

  it("the committed sample golden set is well-formed and fully labeled", () => {
    expect(typeof parsed.k).toBe("number");
    expect(Array.isArray(parsed.cases)).toBe(true);
    expect(parsed.cases.length).toBeGreaterThan(0);
    for (const c of parsed.cases) {
      expect(typeof c.query).toBe("string");
      expect(Array.isArray(c.expected)).toBe(true);
      expect(c.expected.length).toBeGreaterThan(0); // labeled
      expect(Array.isArray(c.retrieved)).toBe(true);
    }
  });

  it("scores at or above the regression floor", () => {
    const agg = aggregate(parsed.cases, parsed.k);
    expect(agg.labeled).toBe(parsed.cases.length);
    expect(agg.recallAtK).toBeGreaterThanOrEqual(RECALL_FLOOR);
    expect(agg.mrr).toBeGreaterThan(0);
  });

  it("flags a regressed retriever (sanity check on the gate itself)", () => {
    // A retriever that returns the wrong files must score below the floor.
    const broken = parsed.cases.map((c) => ({ ...c, retrieved: ["totally/unrelated.ts"] }));
    expect(aggregate(broken, parsed.k).recallAtK).toBeLessThan(RECALL_FLOOR);
    expect(recallAtK(["a.ts"], ["b.ts"], 6)).toBe(0);
  });
});

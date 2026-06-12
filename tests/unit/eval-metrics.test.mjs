import { describe, it, expect } from "vitest";
import { recallAtK, mrr, aggregate } from "../../eval/metrics.mjs";

describe("recallAtK", () => {
  it("is 1 when the expected file is within the top k retrieved", () => {
    expect(recallAtK(["a.ts"], ["b.ts", "a.ts", "c.ts"], 6)).toBe(1);
  });

  it("is 0 when the expected file is absent", () => {
    expect(recallAtK(["a.ts"], ["b.ts", "c.ts"], 6)).toBe(0);
  });

  it("respects the k cutoff (a hit beyond k does not count)", () => {
    expect(recallAtK(["a.ts"], ["b.ts", "a.ts"], 1)).toBe(0);
  });

  it("is the fraction of expected files found for multi-label cases", () => {
    expect(recallAtK(["a.ts", "x.ts"], ["a.ts", "b.ts"], 6)).toBe(0.5);
  });

  it("returns null for unlabeled cases (no expected files)", () => {
    expect(recallAtK([], ["a.ts"], 6)).toBeNull();
  });
});

describe("mrr", () => {
  it("is the reciprocal of the rank of the first expected hit", () => {
    expect(mrr(["a.ts"], ["b.ts", "a.ts"])).toBe(0.5);
  });

  it("is 1 when the expected file is ranked first", () => {
    expect(mrr(["a.ts"], ["a.ts", "b.ts"])).toBe(1);
  });

  it("is 0 when no expected file is retrieved", () => {
    expect(mrr(["a.ts"], ["b.ts"])).toBe(0);
  });

  it("returns null for unlabeled cases", () => {
    expect(mrr([], ["a.ts"])).toBeNull();
  });
});

describe("aggregate", () => {
  it("averages recall@k and MRR over labeled cases only, reporting coverage", () => {
    const cases = [
      { query: "q1", expected: ["a.ts"], retrieved: ["a.ts", "z.ts"] }, // recall 1, rr 1
      { query: "q2", expected: ["b.ts"], retrieved: ["z.ts", "b.ts"] }, // recall 1, rr 0.5
      { query: "q3", expected: [], retrieved: ["z.ts"] }, // unlabeled, skipped
    ];
    const r = aggregate(cases, 6);
    expect(r.labeled).toBe(2);
    expect(r.total).toBe(3);
    expect(r.recallAtK).toBe(1);
    expect(r.mrr).toBe(0.75);
  });
});

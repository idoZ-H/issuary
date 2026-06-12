// Retrieval-quality metrics for the semantic-code-retrieval eval harness.
//
// Plain ESM (no TypeScript) so the offline runner executes under bare `node`
// (the repo has no tsx/ts-node). The same module is unit-tested by vitest
// (tests/unit/eval-metrics.test.mjs), so the math has a single source of truth.
//
// Conventions:
// - `expected`  : ground-truth file paths a query SHOULD surface (human-labeled).
// - `retrieved` : the ordered file paths the retriever returned (rank 1 first;
//                 may contain one entry per chunk, so the same file can repeat).
// - Unlabeled cases (expected.length === 0) score `null` and are excluded from
//   aggregates — you cannot measure recall without ground truth.

/**
 * Recall@k: fraction of expected files present in the top-k retrieved entries.
 * @param {string[]} expected
 * @param {string[]} retrieved
 * @param {number} k
 * @returns {number|null}
 */
export function recallAtK(expected, retrieved, k) {
  if (expected.length === 0) return null;
  const topK = new Set(retrieved.slice(0, k));
  const hits = expected.filter((e) => topK.has(e)).length;
  return hits / expected.length;
}

/**
 * Mean reciprocal rank for a single case: 1/rank of the first expected hit
 * (1-indexed), or 0 if none of the expected files were retrieved.
 * @param {string[]} expected
 * @param {string[]} retrieved
 * @returns {number|null}
 */
export function mrr(expected, retrieved) {
  if (expected.length === 0) return null;
  const want = new Set(expected);
  for (let i = 0; i < retrieved.length; i++) {
    if (want.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Aggregate recall@k and MRR over a set of cases, scoring labeled cases only.
 * @param {{query: string, expected: string[], retrieved: string[]}[]} cases
 * @param {number} k
 * @returns {{total: number, labeled: number, recallAtK: number|null, mrr: number|null}}
 */
export function aggregate(cases, k) {
  const labeled = cases.filter((c) => c.expected.length > 0);
  if (labeled.length === 0) {
    return { total: cases.length, labeled: 0, recallAtK: null, mrr: null };
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    total: cases.length,
    labeled: labeled.length,
    recallAtK: mean(labeled.map((c) => recallAtK(c.expected, c.retrieved, k))),
    mrr: mean(labeled.map((c) => mrr(c.expected, c.retrieved))),
  };
}

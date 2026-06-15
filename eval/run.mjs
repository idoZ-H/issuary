// Score the labeled golden set and print recall@k + MRR.
//
// Usage:  node eval/run.mjs
//
// Reads eval/golden-set.json (produced by seed.mjs, then human-labeled), and
// reports per-case and aggregate retrieval quality for the BASELINE retriever
// (the paths captured in the traces). To measure a NEW retriever variant,
// re-seed after deploying it so fresh traces carry the new results, then re-run.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { recallAtK, mrr, aggregate } from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = join(HERE, "golden-set.json");
const SAMPLE = join(HERE, "golden-set.sample.json");

// Prefer the real (gitignored) golden set; fall back to the committed synthetic
// sample so `npm run eval` works out of the box (and in CI) without secrets.
const FILE = existsSync(REAL) ? REAL : SAMPLE;
if (!existsSync(FILE)) {
  console.error(`No golden set at ${REAL} or ${SAMPLE}. Run: node eval/seed.mjs`);
  process.exit(1);
}
if (FILE === SAMPLE) {
  console.log("(no real golden-set.json — scoring the committed synthetic sample)");
}

const { k = 6, cases } = JSON.parse(readFileSync(FILE, "utf8"));

const fmt = (v) => (v === null ? "  —  " : v.toFixed(3));
console.log(`\nRetrieval eval — k=${k}, ${cases.length} cases\n`);
for (const c of cases) {
  const r = recallAtK(c.expected, c.retrieved, k);
  const m = mrr(c.expected, c.retrieved);
  const tag = c.expected.length ? "" : "  (unlabeled)";
  console.log(`  R@${k}=${fmt(r)}  MRR=${fmt(m)}  ${c.query.slice(0, 60).replace(/\n/g, " ")}${tag}`);
}

const agg = aggregate(cases, k);
console.log(`\n  ── aggregate over ${agg.labeled}/${agg.total} labeled cases ──`);
if (agg.labeled === 0) {
  console.log(`  No labeled cases yet. Edit ${FILE}: fill each \`expected\` with the correct file path(s).`);
} else {
  console.log(`  recall@${k} = ${fmt(agg.recallAtK)}    MRR = ${fmt(agg.mrr)}`);
}
console.log();

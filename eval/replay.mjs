// Offline A/B of the bge query prefix against the LIVE Vectorize index.
//
// Usage:
//   CLOUDFLARE_AI_TOKEN=... node eval/replay.mjs [--repo IdoZ-H/Acme_Core] [--k 6]
//
// For each golden-set query, embeds it two ways via the Workers AI REST API —
// bare (symmetric, the old behavior) and prefixed (asymmetric, the new
// behavior) — queries Vectorize for each, and scores recall@k + MRR against the
// labels. This measures the prefix's real effect on YOUR index in seconds, with
// no deploy and ~negligible neuron cost. The same rig extends to the reranker:
// add a rerank stage between retrieve() and scoring.
//
// Network glue; the scoring math is metrics.mjs (unit-tested). Documents in the
// index were embedded unprefixed, so bare-query == symmetric and prefixed-query
// == the bge-designed asymmetric setup — exactly the comparison we want.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { recallAtK, mrr } from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "golden-set.json");
const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
const INDEX = "feedback-code-index";
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
// MUST match BGE_QUERY_PREFIX in src/pipeline/code-index.ts.
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

const arg = (flag, fb) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fb;
};

const TOK = process.env.CLOUDFLARE_AI_TOKEN;
if (!TOK) {
  console.error("Set CLOUDFLARE_AI_TOKEN (grep ^CLOUDFLARE_AI_TOKEN= .env | cut -d= -f2-).");
  process.exit(1);
}
if (!ACCT) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID (grep ^CLOUDFLARE_ACCOUNT_ID= .env | cut -d= -f2-).");
  process.exit(1);
}
const REPO = arg("--repo", "IdoZ-H/Acme_Core");
const K = Number(arg("--k", "6"));
const H = { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" };

async function embed(text) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/run/${EMBED_MODEL}`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ text: [text] }),
  });
  const d = await r.json();
  if (!d.success) throw new Error("embed: " + JSON.stringify(d.errors));
  return d.result.data[0];
}

async function retrieve(vector) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCT}/vectorize/v2/indexes/${INDEX}/query`,
    { method: "POST", headers: H, body: JSON.stringify({ vector, topK: K, filter: { repo: REPO }, returnMetadata: "all" }) }
  );
  const d = await r.json();
  if (!d.success) throw new Error("query: " + JSON.stringify(d.errors));
  return d.result.matches.map((m) => String(m.metadata?.path ?? ""));
}

async function variants(query) {
  const [bare, pref] = await Promise.all([embed(query), embed(BGE_QUERY_PREFIX + query)]);
  const [rb, rp] = await Promise.all([retrieve(bare), retrieve(pref)]);
  return { bare: rb, prefixed: rp };
}

if (!existsSync(FILE)) {
  console.error("No golden set. Run: node eval/seed.mjs");
  process.exit(1);
}
const gs = JSON.parse(readFileSync(FILE, "utf8"));
const fmt = (v) => (v === null ? "  —  " : v.toFixed(3));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const acc = { bare: { r: [], m: [] }, prefixed: { r: [], m: [] } };

console.log(`\nPrefix A/B vs live index — repo=${REPO}, k=${K}\n`);
for (const c of gs.cases) {
  const v = await variants(c.query);
  const labeled = c.expected.length > 0;
  const score = (name, retrieved) => {
    const r = recallAtK(c.expected, retrieved, K);
    const m = mrr(c.expected, retrieved);
    if (labeled) {
      acc[name].r.push(r);
      acc[name].m.push(m);
    }
    return `R@${K}=${fmt(r)} MRR=${fmt(m)}  [${retrieved.slice(0, 3).join(", ")}]`;
  };
  console.log(`  • ${c.query.slice(0, 55).replace(/\n/g, " ")}${labeled ? "" : "  (unlabeled)"}`);
  console.log(`      bare      ${score("bare", v.bare)}`);
  console.log(`      prefixed  ${score("prefixed", v.prefixed)}`);
}

const n = acc.bare.r.length;
console.log(`\n  ── aggregate over ${n} labeled cases ──`);
if (!n) {
  console.log("  No labels yet — retrieved-set diffs shown above. Label eval/golden-set.json for scores.");
} else {
  console.log(`  bare      recall@${K}=${fmt(mean(acc.bare.r))}  MRR=${fmt(mean(acc.bare.m))}`);
  console.log(`  prefixed  recall@${K}=${fmt(mean(acc.prefixed.r))}  MRR=${fmt(mean(acc.prefixed.m))}`);
}
console.log();

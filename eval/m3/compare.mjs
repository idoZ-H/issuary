// A/B three retriever configs over the golden set, against the eval indexes
// built by build-index.mjs:
//   base|bare    — current production (English bge-base, no prefix)
//   base|prefix  — + the bge asymmetric query prefix (Step 2)
//   m3|bare      — multilingual bge-m3 (the Hebrew-message hypothesis)
//
// Usage:  CLOUDFLARE_AI_TOKEN=... node eval/m3/compare.mjs
//
// Eval indexes hold a single repo, so queries are unfiltered. Scoring math is
// the unit-tested metrics.mjs.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { recallAtK, mrr } from "../metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "golden-set.json");
const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!ACCT) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID (grep ^CLOUDFLARE_ACCOUNT_ID= .env | cut -d= -f2-).");
  process.exit(1);
}
const VBASE = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/vectorize/v2/indexes`;
const AIBASE = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/run`;
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

const TOK = process.env.CLOUDFLARE_AI_TOKEN;
if (!TOK) {
  console.error("Set CLOUDFLARE_AI_TOKEN.");
  process.exit(1);
}
const K = 6;
const H = { Authorization: `Bearer ${TOK}` };

const CONFIGS = [
  { name: "base|bare", index: "feedback-code-index-eval-base", model: "@cf/baai/bge-base-en-v1.5", prefix: "" },
  { name: "base|prefix", index: "feedback-code-index-eval-base", model: "@cf/baai/bge-base-en-v1.5", prefix: BGE_QUERY_PREFIX },
  { name: "m3|bare", index: "feedback-code-index-eval-m3", model: "@cf/baai/bge-m3", prefix: "" },
];

const cf = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  return r.json();
};
async function embed(model, text) {
  const d = await cf(`${AIBASE}/${model}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: [text] }),
  });
  if (!d.success) throw new Error(`embed: ${JSON.stringify(d.errors)}`);
  return d.result.data[0];
}
async function retrieve(index, vector) {
  const d = await cf(`${VBASE}/${index}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vector, topK: K, returnMetadata: "all" }),
  });
  if (!d.success) throw new Error(`query: ${JSON.stringify(d.errors)}`);
  return d.result.matches.map((m) => String(m.metadata?.path ?? ""));
}

if (!existsSync(FILE)) {
  console.error("No golden set. Run: node eval/seed.mjs");
  process.exit(1);
}
const gs = JSON.parse(readFileSync(FILE, "utf8"));
const fmt = (v) => (v === null ? "  —  " : v.toFixed(3));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const acc = Object.fromEntries(CONFIGS.map((c) => [c.name, { r: [], m: [] }]));

console.log(`\nEmbedder A/B over golden set — k=${K}\n`);
for (const c of gs.cases) {
  const labeled = c.expected.length > 0;
  console.log(`  • ${c.query.slice(0, 50).replace(/\n/g, " ")}${labeled ? "" : "  (unlabeled)"}`);
  for (const cfg of CONFIGS) {
    const v = await embed(cfg.model, cfg.prefix + c.query);
    const retrieved = await retrieve(cfg.index, v);
    const r = recallAtK(c.expected, retrieved, K);
    const m = mrr(c.expected, retrieved);
    if (labeled) {
      acc[cfg.name].r.push(r);
      acc[cfg.name].m.push(m);
    }
    console.log(`      ${cfg.name.padEnd(11)} R@${K}=${fmt(r)} MRR=${fmt(m)}  [${retrieved.slice(0, 3).join(", ")}]`);
  }
}

const n = acc[CONFIGS[0].name].r.length;
console.log(`\n  ── aggregate over ${n} labeled cases ──`);
if (!n) {
  console.log("  No labels yet — retrieved-set diffs above. Label eval/golden-set.json for scores.");
} else {
  for (const cfg of CONFIGS) {
    console.log(`  ${cfg.name.padEnd(11)} recall@${K}=${fmt(mean(acc[cfg.name].r))}  MRR=${fmt(mean(acc[cfg.name].m))}`);
  }
}
console.log();

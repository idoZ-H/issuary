// Build two disposable eval indexes over the SAME chunk set — one embedded with
// the current English model (bge-base-en-v1.5, 768d), one with the multilingual
// bge-m3 (1024d) — so compare.mjs can A/B the embedder cleanly. Production's
// feedback-code-index is left untouched.
//
// Usage:
//   CLOUDFLARE_AI_TOKEN=... node eval/m3/build-index.mjs [--repo idoZ-H/Acme_Core] [--ref main]
//
// Source is read via the authenticated `gh` CLI (blobs by sha, so Hebrew paths
// are fine). Chunking reuses the parity-tested port in ./chunker.mjs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chunkFile, isExcluded } from "./chunker.mjs";

const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!ACCT) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID (grep ^CLOUDFLARE_ACCOUNT_ID= .env | cut -d= -f2-).");
  process.exit(1);
}
const VBASE = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/vectorize/v2/indexes`;
const AIBASE = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/run`;
const MAX_FILE_BYTES = 1_000_000;
const MAX_CHUNKS = 3000;
const EMBED_BATCH = 50;
const UPSERT_BATCH = 200;
// bge-base-en caps at ~512 tokens; truncate so a batch stays under the model's
// context window. Applied to BOTH models equally to keep the A/B fair (isolates
// multilingual vs. English on identical input; m3's longer context is a separate
// lever we're not testing here).
const EMBED_MAX_CHARS = 1500;

const TOK = process.env.CLOUDFLARE_AI_TOKEN;
if (!TOK) {
  console.error("Set CLOUDFLARE_AI_TOKEN.");
  process.exit(1);
}
const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const REPO = arg("--repo", "idoZ-H/Acme_Core");
const REF = arg("--ref", "main");
const H = { Authorization: `Bearer ${TOK}` };

const TARGETS = [
  { index: "feedback-code-index-eval-base", model: "@cf/baai/bge-base-en-v1.5", dim: 768 },
  { index: "feedback-code-index-eval-m3", model: "@cf/baai/bge-m3", dim: 1024 },
];

const gh = (path) => execFileSync("gh", ["api", path], { maxBuffer: 64 * 1024 * 1024 }).toString();
const cf = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  return r.json();
};
const id = (path, start) => createHash("sha1").update(`${REPO}:${path}:${start}`).digest("hex");

async function embed(model, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const d = await cf(`${AIBASE}/${model}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: batch }),
    });
    if (!d.success) throw new Error(`embed ${model}: ${JSON.stringify(d.errors)}`);
    out.push(...d.result.data);
  }
  return out;
}

async function recreate(index, dim) {
  await cf(`${VBASE}/${index}`, { method: "DELETE" }); // ignore if absent
  const d = await cf(VBASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: index, config: { dimensions: dim, metric: "cosine" } }),
  });
  if (!d.success) throw new Error(`create ${index}: ${JSON.stringify(d.errors)}`);
}

async function upsert(index, items) {
  for (let i = 0; i < items.length; i += UPSERT_BATCH) {
    const nd = items.slice(i, i + UPSERT_BATCH).map((x) => JSON.stringify(x)).join("\n");
    const d = await cf(`${VBASE}/${index}/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: nd,
    });
    if (!d.success) throw new Error(`upsert ${index}: ${JSON.stringify(d.errors)}`);
  }
}

async function main() {
  console.log(`Reading ${REPO}@${REF} tree…`);
  const tree = JSON.parse(gh(`repos/${REPO}/git/trees/${REF}?recursive=1`)).tree;
  const blobs = tree.filter(
    (t) => t.type === "blob" && !isExcluded(t.path) && (t.size ?? 0) <= MAX_FILE_BYTES
  );
  console.log(`  ${blobs.length} candidate files (after exclusions/size cap).`);

  const chunks = [];
  let read = 0;
  for (const b of blobs) {
    if (chunks.length >= MAX_CHUNKS) break;
    const blob = JSON.parse(gh(`repos/${REPO}/git/blobs/${b.sha}`));
    const content = Buffer.from(blob.content, "base64").toString("utf8");
    for (const c of chunkFile(content, b.path)) {
      chunks.push(c);
      if (chunks.length >= MAX_CHUNKS) break;
    }
    if (++read % 50 === 0) console.log(`  read ${read}/${blobs.length} files, ${chunks.length} chunks…`);
  }
  console.log(`  ${chunks.length} chunks from ${read} files.`);

  const texts = chunks.map((c) => c.text.slice(0, EMBED_MAX_CHARS));
  for (const t of TARGETS) {
    console.log(`\n[${t.index}] embedding ${chunks.length} chunks with ${t.model}…`);
    const vectors = await embed(t.model, texts);
    const items = chunks.map((c, i) => ({
      id: id(c.path, c.start_line),
      values: vectors[i],
      metadata: { repo: REPO, path: c.path, start_line: c.start_line, end_line: c.end_line, snippet: c.text.slice(0, 1000) },
    }));
    console.log(`[${t.index}] recreating index (${t.dim}d) + upserting…`);
    await recreate(t.index, t.dim);
    await upsert(t.index, items);
    console.log(`[${t.index}] upsert queued (${items.length} vectors). Becomes queryable in ~1-2 min.`);
  }
  console.log(`\nDone. Wait ~2 min for consistency, then: node eval/m3/compare.mjs`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

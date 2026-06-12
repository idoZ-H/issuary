#!/usr/bin/env bash
# Verify the feedback-bot production semantic code-index rebuilt CLEAN after its
# 7-day TTL, once the hygiene fix (commit d7fa78a / deployed version fb1ed680,
# live 2026-06-04) is in effect. Reads the CODE_INDEX_META manifest for the
# given repo via the Cloudflare KV REST API — no Vectorize/AI token,
# no Claude, no wrangler needed. Safe to run from cron/at.
#
#   clean rebuild  -> status=complete, fetched_at > ~Jun 8, chunk_count ~1445, no junk paths
#   junk ingested  -> chunk_count ~1879 and/or .xlsx/lock/.log/.png in paths
#
# Usage: scripts/verify-clean-index.sh <owner/repo>   (writes a report file + prints it)
set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"
ACCT="$(grep '^CLOUDFLARE_ACCOUNT_ID=' "$ENV_FILE" | cut -d= -f2-)"
NS="${CODE_INDEX_META_NS:-}"   # CODE_INDEX_META KV namespace id (from your gitignored wrangler.toml)
REPO="${1:-owner/repo}"
REPORT="$(dirname "$0")/../index-rebuild-check.txt"

TOKEN="$(grep '^CLOUDFLARE_API_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$TOKEN" ] || { echo "No CLOUDFLARE_API_TOKEN in $ENV_FILE" | tee "$REPORT"; exit 1; }
[ -n "$ACCT" ] || { echo "No CLOUDFLARE_ACCOUNT_ID in $ENV_FILE" | tee "$REPORT"; exit 1; }
[ -n "$NS" ] || { echo "Set CODE_INDEX_META_NS to your CODE_INDEX_META namespace id" | tee "$REPORT"; exit 1; }

# KV key is the repo string, URL-encoded ("/" -> %2F).
KEY="${REPO//\//%2F}"
URL="https://api.cloudflare.com/client/v4/accounts/${ACCT}/storage/kv/namespaces/${NS}/values/${KEY}"

MANIFEST="$(curl -s -H "Authorization: Bearer ${TOKEN}" "$URL")"

node -e '
const m = JSON.parse(process.argv[1] || "{}");
const lines = [];
const p = (s) => lines.push(s);
p("=== feedback-bot prod code-index rebuild check ===");
p("checked_at: " + new Date().toISOString());
if (!m || !m.fetched_at) {
  p("RESULT: ERROR — could not read manifest (KV returned: " + (process.argv[1]||"").slice(0,200) + ")");
  console.log(lines.join("\n")); process.exit(2);
}
const fetched = new Date(m.fetched_at);
const ageDays = (Date.now() - fetched.getTime()) / 86400000;
const cc = m.chunk_count;
const paths = Array.isArray(m.paths) ? m.paths : [];
const junkRe = /\.(xlsx?|png|jpe?g|gif|svg|webp|ico|pdf|woff2?|ttf|otf|log|dump|csv|tsv|min\.(js|css)|bundle\.js)$/i;
const junkNames = new Set(["package-lock.json","yarn.lock","pnpm-lock.yaml","npm-shrinkwrap.json","diff.txt"]);
const junk = paths.filter(x => junkRe.test(x) || junkNames.has(x.split("/").pop().toLowerCase()));
p("status:       " + m.status);
p("fetched_at:   " + m.fetched_at + "  (" + ageDays.toFixed(1) + "d ago)");
p("chunk_count:  " + cc + "   (clean≈1445, junk≈1879)");
p("paths:        " + paths.length + " files");
p("junk paths:   " + junk.length + (junk.length ? "  -> " + junk.slice(0,10).join(", ") : ""));
p("");
// June 8 2026 = the TTL-expiry rebuild window.
const rebuilt = fetched.getTime() >= Date.parse("2026-06-08T00:00:00Z");
if (m.status !== "complete") {
  p("RESULT: WAIT — index not 'complete' yet (status=" + m.status + "). Re-run shortly.");
} else if (!rebuilt) {
  p("RESULT: WAIT — manifest still pre-Jun-8 (" + m.fetched_at + "); TTL has not triggered a rebuild yet. Re-check in a day. NOT a failure.");
} else if (junk.length === 0 && cc < 1700) {
  p("RESULT: ✅ DEFUSED — clean rebuild. No junk paths, chunk_count " + cc + " in the clean range.");
} else {
  p("RESULT: ❌ REGRESSION — junk_paths=" + junk.length + ", chunk_count=" + cc + ". Exclusions did NOT take effect; investigate the deployed isExcludedFromCodeIndex.");
}
console.log(lines.join("\n"));
' "$MANIFEST" | tee "$REPORT"

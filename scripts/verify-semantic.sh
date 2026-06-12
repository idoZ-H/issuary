#!/usr/bin/env bash
# Verify that semantic code retrieval recovered after the Workers AI neuron
# fix (CODE_INDEX_TTL_S 6h->7d, cron */1->*/30, deployed 2026-06-01 on branch
# worktree-feat+semantic-code-retrieval). Run on the morning of 2026-06-02
# (after the 00:00 UTC neuron reset). Reads secrets from ./.env.
#
# Usage: bash scripts/verify-semantic.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TOK=$(grep '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2-)
LSK=$(grep '^LANGSMITH_API_KEY=' .env | cut -d= -f2-)
ACC=$(grep '^CLOUDFLARE_ACCOUNT_ID=' .env | cut -d= -f2-)
META="${CODE_INDEX_META_NS:-}"   # CODE_INDEX_META KV namespace id (from your gitignored wrangler.toml)
REPO="${1:-owner/repo}"
REPO_KEY="${REPO//\//%2F}"
LS_PROJECT="${LANGSMITH_PROJECT_UUID:-}"   # your LangSmith project UUID
TODAY=$(date -u +%Y-%m-%d)
[ -n "$ACC" ] || { echo "Set CLOUDFLARE_ACCOUNT_ID in .env"; exit 1; }
[ -n "$META" ] || { echo "Set CODE_INDEX_META_NS to your CODE_INDEX_META namespace id"; exit 1; }
[ -n "$LS_PROJECT" ] || { echo "Set LANGSMITH_PROJECT_UUID to your LangSmith project UUID"; exit 1; }

echo "=========================================="
echo " Semantic-retrieval recovery check ($(date -u +%FT%TZ))"
echo "=========================================="

echo; echo "[1/3] Index manifest status (expect: complete, cursor==total)"
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACC/storage/kv/namespaces/$META/values/$REPO_KEY" \
  -H "Authorization: Bearer $TOK" \
| python3 -c "import sys,json;m=json.load(sys.stdin);done=m['status']=='complete' and m['cursor']==len(m['paths']);print('  status:',m['status'],'| cursor:',m['cursor'],'/',len(m['paths']),'| chunks:',m['chunk_count'],'| fetched_at:',m['fetched_at']);print('  =>','✅ COMPLETE' if done else '❌ STILL BUILDING')"

echo; echo "[2/3] Cloudflare usage today (neurons being consumed, KV lists < 1000)"
curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"query\":\"query{viewer{accounts(filter:{accountTag:\\\"$ACC\\\"}){aiInferenceAdaptiveGroups(limit:50,filter:{date_geq:\\\"$TODAY\\\"}){sum{totalNeurons}dimensions{date modelId}} kvOperationsAdaptiveGroups(limit:50,filter:{date_geq:\\\"$TODAY\\\"}){sum{requests}dimensions{actionType}}}}}\"}" \
| python3 -c "
import sys,json,collections
d=json.load(sys.stdin);a=(d.get('data') or {}).get('viewer',{}).get('accounts',[{}])[0]
ai=a.get('aiInferenceAdaptiveGroups',[]); kv=a.get('kvOperationsAdaptiveGroups',[])
neur=sum(r['sum']['totalNeurons'] for r in ai)
lists=sum(r['sum']['requests'] for r in kv if r['dimensions']['actionType']=='list')
print('  neurons today:',round(neur),'/ 10000  =>', '✅' if 0<neur<10000 else ('⚠ zero (no embeds yet)' if neur==0 else '❌ at/over cap'))
print('  KV lists today:',lists,'/ 1000  =>', '✅' if lists<1000 else '❌ over cap')
print('  errors:',d.get('errors'))
"

echo; echo "[3/3] LangSmith: recent runs with semantic_matches / any semantic_retrieve_failed"
curl -s -X POST 'https://api.smith.langchain.com/runs/query' -H "x-api-key: $LSK" -H 'Content-Type: application/json' \
  -d "{\"session\":[\"$LS_PROJECT\"],\"start_time\":\"${TODAY}T00:00:00Z\",\"limit\":40,\"order\":\"desc\",\"select\":[\"start_time\",\"name\",\"outputs\",\"error\"]}" \
| python3 -c "
import sys,json
runs=json.load(sys.stdin); runs=runs.get('runs',runs) if isinstance(runs,dict) else runs
sem=sum(1 for r in runs if 'semantic_matches' in json.dumps(r.get('outputs',{})))
print('  runs today:',len(runs),'| runs containing semantic_matches:',sem)
print('  =>','✅ semantic_matches flowing' if sem>0 else '⚠ no semantic_matches yet (send a bug report to the bot to generate one)')
"
echo; echo "Done. If [1] shows COMPLETE and you then send the bot a bug report, [3] should show semantic_matches."

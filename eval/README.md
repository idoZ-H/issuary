# Semantic retrieval eval harness

Measures retrieval quality (recall@k, MRR) for the code-index semantic search,
so changes to the retriever (query prefix, reranker, HyDE, embedding model) are
**measured** instead of guessed.

It reuses LangSmith as the eval backend — the cases are bootstrapped from the
real `runClassifier` traces you already produce. No new infra.

## Files

| File | What it is |
|---|---|
| `metrics.mjs` | Pure `recallAtK` / `mrr` / `aggregate`. Unit-tested in `tests/unit/eval-metrics.test.mjs`. |
| `extract.mjs` | Pure parsing of LangSmith runs → eval cases. Unit-tested in `tests/unit/eval-extract.test.mjs`. |
| `seed.mjs` | Node script: fetch traces from LangSmith → write `golden-set.json`. |
| `run.mjs` | Node script: score the **baseline** (paths captured in traces). |
| `replay.mjs` | Node script: **live A/B** — re-embeds each query against the real Vectorize index (Workers AI + Vectorize REST) and scores variant-vs-variant in seconds, no deploy. |
| `golden-set.json` | The dataset (gitignored — it holds real client message text). |

Everything is plain ESM `.mjs` because the repo has no `tsx`/`ts-node`; the
scripts must run under bare `node`. The math lives in one place and is covered by
vitest.

## Workflow

```bash
# 1. Seed cases from the last N days of traces (preserves any existing labels)
LANGSMITH_API_KEY=$(grep ^LANGSMITH_API_KEY= .env | cut -d= -f2-) node eval/seed.mjs --days 90

# 2. Label: open eval/golden-set.json and, for each real case, fill `expected`
#    with the file path(s) that SHOULD be retrieved, e.g.
#      "expected": ["src/services/whatsapp.js"]
#    Leave test/noise messages ("בדיקה", "test") empty — they're auto-skipped.

# 3. Score the baseline
node eval/run.mjs
```

`run.mjs` scores the **baseline** retriever — the paths captured in the traces.

To measure a change **without deploying or waiting on traffic**, use `replay.mjs`:

```bash
CLOUDFLARE_AI_TOKEN=$(grep ^CLOUDFLARE_AI_TOKEN= .env | cut -d= -f2-) node eval/replay.mjs
```

It re-embeds every query against the live index two ways (bare vs bge-prefixed)
and scores both, so you get a deterministic A/B in seconds. Extending it to the
reranker is a single stage between `retrieve()` and scoring.

Note: the query model must match the model the index was built with (same vector
space + dimensions). Swapping `EMBED_MODEL` here alone would mismatch the 768-dim
index. To test a different embedder (e.g. multilingual `@cf/baai/bge-m3`, 1024-dim,
for the Hebrew messages), build a parallel index with it first, then point replay
at that index.

## Notes

- `k` defaults to 6 (matches `RETRIEVAL_TOP_K`). Override in `golden-set.json`.
- Recall is computed at the **file** level over the top-k retrieved chunks.
- A query can appear under multiple `traceId`s (retries / shadow runs); that's
  fine — label each, or dedupe by hand if you prefer.

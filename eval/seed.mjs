// Seed (or refresh) eval/golden-set.json from real LangSmith traces.
//
// Usage:
//   LANGSMITH_API_KEY=... node eval/seed.mjs [--days 30] [--limit 100]
//
// Pulls runClassifier traces, extracts each client message + the paths the
// retriever actually returned, and writes them as eval cases with an empty
// `expected` array for you to label. Existing `expected` labels are preserved on
// re-seed (matched by traceId), so this is safe to re-run as new messages land.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractRetrievalCases } from "./extract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "golden-set.json");

// LangSmith project "feedback-bot" (see CLAUDE.md).
const SESSION = "<your-langsmith-project-uuid>";
const API = "https://api.smith.langchain.com/api/v1/runs/query";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const key = process.env.LANGSMITH_API_KEY;
  if (!key) {
    console.error("Set LANGSMITH_API_KEY (grep ^LANGSMITH_API_KEY= .env | cut -d= -f2-).");
    process.exit(1);
  }
  const days = Number(arg("--days", "30"));
  const limit = Math.min(Number(arg("--limit", "100")), 100); // LangSmith caps at 100
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      session: [SESSION],
      start_time: start,
      limit,
      select: ["id", "name", "run_type", "trace_id", "inputs", "outputs"],
    }),
  });
  if (!res.ok) {
    console.error(`LangSmith query failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  const runs = Array.isArray(data) ? data : data.runs ?? [];
  const cases = extractRetrievalCases(runs);

  // Preserve any labels already applied (match by traceId).
  if (existsSync(OUT)) {
    const prior = JSON.parse(readFileSync(OUT, "utf8"));
    const labels = new Map((prior.cases ?? []).map((c) => [c.traceId, c.expected]));
    for (const c of cases) {
      const kept = labels.get(c.traceId);
      if (kept && kept.length) c.expected = kept;
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    project: "feedback-bot",
    k: 6,
    note: "Label each case: put the file path(s) that SHOULD be retrieved into `expected`. Then run `node eval/run.mjs`.",
    cases,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  const labeled = cases.filter((c) => c.expected.length).length;
  console.log(`Wrote ${cases.length} cases to ${OUT} (${labeled} already labeled).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

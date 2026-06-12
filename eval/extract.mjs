// Pure extraction helpers that turn raw LangSmith runs into eval cases.
//
// A LangSmith trace for one Telegram message is a `runClassifier` chain plus its
// child `ChatAnthropic` runs. The client's message is on the classifier's
// `inputs.userText`; the semantic matches the retriever returned are embedded —
// as a stringified tool_result — inside the child runs, each shaped like
// `{"path": "...", "start_line": N, "end_line": N, "snippet": "...", "score": N}`.
//
// Kept pure (no network/fs) so it is unit-tested directly; the Node glue in
// seed.mjs fetches the runs and feeds them here.

/**
 * Extract retrieved file paths from a (possibly escaped) JSON blob, ordered by
 * descending semantic score and deduped to the highest score per path.
 * @param {string} text
 * @returns {string[]}
 */
export function extractScoredPaths(text) {
  // Tool results are stored as a JSON string inside message content, so quotes
  // arrive escaped (\"path\"). Normalize before matching.
  const normalized = text.replace(/\\"/g, '"');
  const re = /"path":"([^"]+)"[\s\S]*?"score":\s*([0-9.]+)/g;
  /** @type {Map<string, number>} */
  const best = new Map();
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const path = m[1];
    const score = parseFloat(m[2]);
    if (!best.has(path) || score > best.get(path)) best.set(path, score);
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
}

/**
 * Group runs by trace and pair each classifier query with the score-ranked
 * paths retrieved in that trace. `expected` is left empty for human labeling.
 * @param {Array<Record<string, any>>} runs
 * @returns {{traceId: string, query: string, retrieved: string[], expected: string[]}[]}
 */
export function extractRetrievalCases(runs) {
  /** @type {Map<string, Record<string, any>[]>} */
  const byTrace = new Map();
  for (const r of runs) {
    const t = r.trace_id ?? r.traceId;
    if (!t) continue;
    if (!byTrace.has(t)) byTrace.set(t, []);
    byTrace.get(t).push(r);
  }

  const cases = [];
  for (const [traceId, traceRuns] of byTrace) {
    const classifier = traceRuns.find(
      (r) => r.name === "runClassifier" && r.inputs && typeof r.inputs.userText === "string"
    );
    if (!classifier) continue;
    const blob = JSON.stringify(traceRuns);
    cases.push({
      traceId,
      query: classifier.inputs.userText,
      retrieved: extractScoredPaths(blob),
      expected: [],
    });
  }
  return cases;
}

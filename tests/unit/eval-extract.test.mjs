import { describe, it, expect } from "vitest";
import { extractScoredPaths, extractRetrievalCases } from "../../eval/extract.mjs";

describe("extractScoredPaths", () => {
  it("returns file paths ordered by descending score", () => {
    const text =
      '[{"path":"a.js","start_line":1,"end_line":5,"snippet":"x","score":0.71},' +
      '{"path":"b.js","start_line":2,"end_line":9,"snippet":"y","score":0.92}]';
    expect(extractScoredPaths(text)).toEqual(["b.js", "a.js"]);
  });

  it("dedupes a path to its highest score", () => {
    const text =
      '{"path":"a.js","snippet":"x","score":0.55},{"path":"a.js","snippet":"y","score":0.71}';
    expect(extractScoredPaths(text)).toEqual(["a.js"]);
  });

  it("parses escaped JSON (tool results embedded as a string)", () => {
    // As paths appear inside a stringified tool_result in a LangSmith message.
    const escaped = String.raw`\"path\":\"src/services/whatsapp.js\",\"snippet\":\"z\",\"score\":0.74`;
    expect(extractScoredPaths(escaped)).toEqual(["src/services/whatsapp.js"]);
  });

  it("returns an empty array when there are no matches", () => {
    expect(extractScoredPaths("no paths here")).toEqual([]);
  });
});

describe("extractRetrievalCases", () => {
  it("pairs each classifier query with its trace's score-ranked retrieved paths", () => {
    const runs = [
      { trace_id: "t1", name: "runClassifier", inputs: { userText: "fix login" } },
      {
        trace_id: "t1",
        name: "ChatAnthropic",
        outputs: {
          content:
            '{"path":"b.js","snippet":"x","score":0.9},{"path":"a.js","snippet":"y","score":0.7}',
        },
      },
    ];
    expect(extractRetrievalCases(runs)).toEqual([
      { traceId: "t1", query: "fix login", retrieved: ["b.js", "a.js"], expected: [] },
    ]);
  });

  it("skips traces that have no classifier userText", () => {
    const runs = [{ trace_id: "t9", name: "ChatAnthropic", outputs: { content: "noise" } }];
    expect(extractRetrievalCases(runs)).toEqual([]);
  });
});

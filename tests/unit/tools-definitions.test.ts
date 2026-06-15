import { describe, it, expect } from "vitest";
import { CLASSIFIER_TOOLS } from "../../src/tools/definitions";

describe("CLASSIFIER_TOOLS", () => {
  it("exposes exactly 4 tools, alphabetically sorted by name", () => {
    expect(CLASSIFIER_TOOLS).toHaveLength(4);
    const names = CLASSIFIER_TOOLS.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual([
      "ask_clarifying_question",
      "github_read_file",
      "github_search_code",
      "github_search_issues",
    ]);
  });

  it("github_search_code carries a required semantic_query (HyDE) field for NL retrieval", () => {
    const t = CLASSIFIER_TOOLS.find((x) => x.name === "github_search_code") as any;
    expect(t.input_schema.properties.semantic_query).toBeDefined();
    expect(t.input_schema.properties.semantic_query.type).toBe("string");
    expect(t.input_schema.required).toContain("semantic_query");
    expect(t.input_schema.required).toContain("query");
  });

  it("each tool has a description, input_schema, and strict:true", () => {
    for (const t of CLASSIFIER_TOOLS) {
      expect(t.description!.length).toBeGreaterThan(50);
      expect((t as any).input_schema.type).toBe("object");
      expect((t as any).input_schema.additionalProperties).toBe(false);
      expect((t as any).strict).toBe(true);
    }
  });
});

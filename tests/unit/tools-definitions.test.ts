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

  it("each tool has a description, input_schema, and strict:true", () => {
    for (const t of CLASSIFIER_TOOLS) {
      expect(t.description!.length).toBeGreaterThan(50);
      expect((t as any).input_schema.type).toBe("object");
      expect((t as any).input_schema.additionalProperties).toBe(false);
      expect((t as any).strict).toBe(true);
    }
  });
});

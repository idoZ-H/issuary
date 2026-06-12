import { describe, it, expect, vi } from "vitest";
import { ClaudeClient, CLASSIFIER_OUTPUT_SCHEMA } from "../../src/lib/ai";
import { CLASSIFICATION_TYPES, SEVERITIES } from "../../src/types";
import type { ClassifierOutput } from "../../src/types";

describe("ClaudeClient", () => {
  it("calls messages.create with the model and system blocks", async () => {
    const fakeMessages = {
      create: vi.fn(async () => ({
        id: "msg_1",
        stop_reason: "end_turn",
        content: [{ type: "text", text: '{"should_create_issue":false}' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      })),
    };
    const sdkLike = { messages: fakeMessages } as any;
    const client = new ClaudeClient(sdkLike);
    const r = await client.classify({
      system: [{ type: "text", text: "system" }],
      userTurns: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    });
    expect(fakeMessages.create).toHaveBeenCalledOnce();
    const args = (fakeMessages.create.mock.calls as any[])[0]![0] as any;
    expect(args.model).toBe("claude-opus-4-8");
    expect(args.system).toBeDefined();
    expect(args.tools).toBeDefined();
    expect((r as any).stop_reason).toBe("end_turn");
  });

  it("constrains the final turn with output_config.format json_schema", async () => {
    const fakeMessages = {
      create: vi.fn(async () => ({
        id: "msg_1",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    };
    const client = new ClaudeClient({ messages: fakeMessages } as any);
    await client.classify({ system: [{ type: "text", text: "s" }], userTurns: [], tools: [] });
    const args = (fakeMessages.create.mock.calls as any[])[0]![0] as any;
    // effort and the structured-output format both ride in output_config.
    expect(args.output_config.effort).toBe("high");
    expect(args.output_config.format.type).toBe("json_schema");
    expect(args.output_config.format.schema).toBe(CLASSIFIER_OUTPUT_SCHEMA);
  });
});

describe("CLASSIFIER_OUTPUT_SCHEMA", () => {
  // This drift test is the enforcement that used to live as runtime enum
  // validation in classifier.ts. Structured outputs enforces the schema at the
  // API level; this guards the schema itself against drifting from the
  // ClassifierOutput type / the type & severity unions.
  it("is a closed object requiring every ClassifierOutput field", () => {
    expect(CLASSIFIER_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    // Every key of ClassifierOutput must be required by the schema.
    const keys: (keyof ClassifierOutput)[] = [
      "should_create_issue", "is_followup_to_issue", "type", "severity",
      "title_en", "body_he", "suggested_labels", "sensitive", "client_reply_he",
    ];
    expect([...CLASSIFIER_OUTPUT_SCHEMA.required].sort()).toEqual([...keys].sort());
    expect(Object.keys(CLASSIFIER_OUTPUT_SCHEMA.properties).sort()).toEqual([...keys].sort());
  });

  it("pins the type and severity enums to the single-source-of-truth arrays", () => {
    expect(CLASSIFIER_OUTPUT_SCHEMA.properties.type.enum).toEqual([...CLASSIFICATION_TYPES]);
    expect(CLASSIFIER_OUTPUT_SCHEMA.properties.severity.enum).toEqual([...SEVERITIES]);
    expect(CLASSIFICATION_TYPES).toEqual(["bug", "feature", "question", "chitchat", "out_of_scope"]);
    expect(SEVERITIES).toEqual(["low", "med", "high", "critical"]);
  });

  it("allows is_followup_to_issue to be an integer or null", () => {
    expect(CLASSIFIER_OUTPUT_SCHEMA.properties.is_followup_to_issue.anyOf).toEqual([
      { type: "integer" }, { type: "null" },
    ]);
  });
});

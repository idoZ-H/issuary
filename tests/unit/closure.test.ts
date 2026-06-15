import { describe, it, expect, vi } from "vitest";
import { draftClosureMessage } from "../../src/pipeline/closure";

describe("draftClosureMessage", () => {
  it("calls Claude with the issue title and Ido's closing comment", async () => {
    const claude = {
      sdk: {
        messages: {
          create: vi.fn(async () => ({
            content: [{ type: "text", text: "תיקנו את הבאג. תודה על הדיווח 🙏" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          })),
        },
      },
    };
    const text = await draftClosureMessage(claude as any, {
      title: "Export button broken",
      closing_comment: "Fixed in v1.4.2",
    });
    expect(text).toContain("תיקנו");
  });

  it("falls back to a default message when Claude throws (API error)", async () => {
    const claude = {
      sdk: {
        messages: {
          create: vi.fn(async () => { throw new Error("anthropic 529 overloaded"); }),
        },
      },
    };
    const text = await draftClosureMessage(claude as any, {
      title: "Export button broken", closing_comment: "Fixed",
    });
    expect(text).toBe("הטיקט נסגר.");
  });

  it("falls back to a default message when Claude returns no text block", async () => {
    const claude = {
      sdk: {
        messages: {
          create: vi.fn(async () => ({
            content: [],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 0 },
          })),
        },
      },
    };
    const text = await draftClosureMessage(claude as any, {
      title: "T", closing_comment: "",
    });
    expect(text).toBe("הטיקט נסגר.");
  });
});

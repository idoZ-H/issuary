import { describe, it, expect, vi } from "vitest";
import { notifyClient, notifyIdo, notifyClientWithProject } from "../../src/pipeline/notifier";

describe("notifier", () => {
  it("sends the Hebrew reply to the client's chat", async () => {
    const tg = { sendMessage: vi.fn(async (_chatId: number, _text: string) => ({ message_id: 1 })) };
    await notifyClient(tg as any, 42, "תודה!");
    expect(tg.sendMessage).toHaveBeenCalledWith(42, "תודה!", undefined);
  });

  it("sends a structured digest to Ido's inbox channel", async () => {
    const tg = { sendMessage: vi.fn(async (_chatId: number, _text: string, _opts?: unknown) => ({ message_id: 2 })) };
    await notifyIdo(tg as any, -1001234, {
      action: "created",
      reporter_name: "Yossi",
      repo: "x/y",
      issue_number: 42,
      issue_url: "https://github.com/x/y/issues/42",
      type: "bug",
      severity: "high",
      sensitive: false,
    });
    const args = tg.sendMessage.mock.calls[0]!;
    expect(args[0]).toBe(-1001234);
    expect(args[1]).toContain("Yossi");
    expect(args[1]).toContain("x/y#42");
    expect(args[1]).toContain("bug");
    expect(args[1]).toContain("high");
    // HTML parse mode — bold uses <b>, links use <a href>
    expect(args[1]).toContain("<b>New issue</b>");
    expect(args[1]).toContain('<a href="https://github.com/x/y/issues/42">');
    expect(args[2]).toEqual({ parseMode: "HTML" });
  });

  it("appends a low-grounding warning when the issue was filed without confident code grounding", async () => {
    const tg = { sendMessage: vi.fn(async (_chatId: number, _text: string, _opts?: unknown) => ({ message_id: 9 })) };
    await notifyIdo(tg as any, -1, {
      action: "created", reporter_name: "Yossi", repo: "x/y",
      issue_number: 7, issue_url: "u", type: "bug", severity: "high", sensitive: false,
      low_grounding: true,
    });
    const text = tg.sendMessage.mock.calls[0]![1];
    expect(text).toContain("⚠️");
    expect(text.toLowerCase()).toContain("grounding");
  });

  it("omits the low-grounding warning when grounding was fine", async () => {
    const tg = { sendMessage: vi.fn(async (_chatId: number, _text: string, _opts?: unknown) => ({ message_id: 10 })) };
    await notifyIdo(tg as any, -1, {
      action: "created", reporter_name: "Yossi", repo: "x/y",
      issue_number: 8, issue_url: "u", type: "bug", severity: "high", sensitive: false,
    });
    const text = tg.sendMessage.mock.calls[0]![1];
    expect(text.toLowerCase()).not.toContain("grounding");
  });

  it("prefixes sensitive notifications with a lock", async () => {
    const tg = { sendMessage: vi.fn(async (_chatId: number, _text: string, _opts?: unknown) => ({ message_id: 3 })) };
    await notifyIdo(tg as any, -1, {
      action: "created", reporter_name: "X", repo: "x/y",
      issue_number: 1, issue_url: "u", type: "bug", severity: "high", sensitive: true,
    });
    expect(tg.sendMessage.mock.calls[0]![1]).toMatch(/🔒/);
  });

  it("escapes underscores in repo names (regression: Acme_Core 400)", async () => {
    // Regression test: repo name IdoZ-H/Acme_Core has an underscore that
    // legacy Markdown parsed as an unclosed italic entity, causing a 400.
    // With HTML parse mode the underscore must survive verbatim, and special
    // HTML chars in reporter_name must be entity-escaped.
    const sent: Array<[string, unknown]> = [];
    const tg = {
      sendMessage: vi.fn(async (_c: number, text: string, opts: unknown) => {
        sent.push([text, opts]);
        return { message_id: 10 };
      }),
    };
    await notifyIdo(tg as any, -100, {
      action: "created",
      reporter_name: "Alice <&> Bob",
      repo: "IdoZ-H/Acme_Core",
      issue_number: 7,
      issue_url: "https://github.com/IdoZ-H/Acme_Core/issues/7",
      type: "bug",
      severity: "low",
    });
    const [text, opts] = sent[0]!;
    // Underscore must be present as-is (not triggering italic markup)
    expect(text).toContain("Acme_Core");
    // HTML special chars in reporter_name must be escaped
    expect(text).toContain("Alice &lt;&amp;&gt; Bob");
    // The raw < and & must NOT appear unescaped in the reporter name position
    expect(text).not.toContain("Alice <&>");
    // Parse mode must be HTML
    expect(opts).toEqual({ parseMode: "HTML" });
  });
});

describe("notifyClientWithProject echo header", () => {
  it("prepends '→ <name_he>' for multi-project clients", async () => {
    const sent: string[] = [];
    const tg = { sendMessage: vi.fn(async (_c: number, t: string) => { sent.push(t); return { message_id: 1 }; }) };
    await notifyClientWithProject(tg as any, 100, "תודה", { project_count: 2, project_name_he: "Acme Core" });
    expect(sent[0]).toMatch(/^→ Acme Core/);
    expect(sent[0]).toContain("תודה");
  });

  it("does not prepend for single-project clients", async () => {
    const sent: string[] = [];
    const tg = { sendMessage: vi.fn(async (_c: number, t: string) => { sent.push(t); return { message_id: 1 }; }) };
    await notifyClientWithProject(tg as any, 100, "תודה", { project_count: 1, project_name_he: "Acme Core" });
    expect(sent[0]).toBe("תודה");
  });
});

describe("notifyIdo with project_name_he", () => {
  it("includes 'Project: <name>' line when project_name_he is set", async () => {
    const sent: string[] = [];
    const tg = { sendMessage: vi.fn(async (_c: number, t: string) => { sent.push(t); return { message_id: 1 }; }) };
    const { notifyIdo } = await import("../../src/pipeline/notifier");
    await notifyIdo(tg as any, 999, {
      action: "created", reporter_name: "Yossi", repo: "x/y",
      issue_number: 42, issue_url: "https://github.com/x/y/issues/42",
      type: "bug", severity: "high", project_name_he: "אקמי קור",
    });
    expect(sent[0]).toContain("Project: אקמי קור");
  });

  it("omits the Project line when project_name_he is absent", async () => {
    const sent: string[] = [];
    const tg = { sendMessage: vi.fn(async (_c: number, t: string) => { sent.push(t); return { message_id: 1 }; }) };
    const { notifyIdo } = await import("../../src/pipeline/notifier");
    await notifyIdo(tg as any, 999, {
      action: "created", reporter_name: "Yossi", repo: "x/y",
      issue_number: 42, issue_url: "https://github.com/x/y/issues/42",
      type: "bug", severity: "high",
    });
    expect(sent[0]).not.toContain("Project:");
  });
});

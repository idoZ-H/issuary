import { describe, it, expect, vi } from "vitest";
import { writeIssueOrComment } from "../../src/pipeline/issue-writer";

const baseOutput = {
  should_create_issue: true,
  is_followup_to_issue: null,
  type: "bug" as const,
  severity: "high" as const,
  title_en: "Export broken",
  // body_he field name is legacy; under the current prompt the content is in English.
  body_he: "## Summary\nThe export button does not respond.",
  suggested_labels: ["dashboard", "export"],
  sensitive: false,
  client_reply_he: "תודה!",
};

describe("writeIssueOrComment", () => {
  it("creates a new issue and applies labels", async () => {
    const gh = {
      createIssue: vi.fn(async () => ({ number: 42, html_url: "https://github.com/x/y/issues/42" })),
      createComment: vi.fn(),
    };
    const r = await writeIssueOrComment(gh as any, "x/y", baseOutput, {
      reporter_name: "Yossi", attachments: [], message_id: 100,
    });
    expect(r.kind).toBe("created");
    if (r.kind === "created") expect(r.number).toBe(42);
    const args = (gh.createIssue.mock.calls as any[])[0]![1] as any;
    expect(args.title).toBe("Export broken");
    expect(args.labels).toEqual(expect.arrayContaining(["from-telegram", "type:bug", "severity:high", "dashboard", "export"]));
    expect(args.body).toContain("Reporter: Yossi");
  });

  it("adds a comment when is_followup_to_issue is set", async () => {
    const gh = { createIssue: vi.fn(), createComment: vi.fn(async () => undefined) };
    const out = { ...baseOutput, should_create_issue: false, is_followup_to_issue: 7 };
    const r = await writeIssueOrComment(gh as any, "x/y", out, {
      reporter_name: "Y", attachments: [], message_id: 200,
    });
    expect(r.kind).toBe("comment");
    if (r.kind === "comment") expect(r.number).toBe(7);
    expect(gh.createComment).toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("falls back to creating a new issue when the follow-up comment 404s (deleted issue)", async () => {
    const gh = {
      createIssue: vi.fn(async () => ({ number: 99, html_url: "https://github.com/x/y/issues/99" })),
      createComment: vi.fn(async () => { throw new Error("createComment: 404 {\"message\":\"Not Found\"}"); }),
    };
    const out = { ...baseOutput, should_create_issue: true, is_followup_to_issue: 101 };
    const r = await writeIssueOrComment(gh as any, "x/y", out, {
      reporter_name: "Y", attachments: [], message_id: 300,
    });
    expect(gh.createComment).toHaveBeenCalled();
    // Comment failed → falls through to creating a fresh issue rather than throwing.
    expect(r.kind).toBe("created");
    if (r.kind === "created") expect(r.number).toBe(99);
    expect(gh.createIssue).toHaveBeenCalled();
  });

  it("adds sensitive label and warning when output.sensitive is true", async () => {
    const gh = { createIssue: vi.fn(async () => ({ number: 1, html_url: "u" })), createComment: vi.fn() };
    const out = { ...baseOutput, sensitive: true };
    await writeIssueOrComment(gh as any, "x/y", out, { reporter_name: "Y", attachments: [], message_id: 1 });
    const args = (gh.createIssue.mock.calls as any[])[0]![1] as any;
    expect(args.labels).toContain("sensitive");
    expect(args.body).toContain("⚠️");
  });

  it("returns kind=skipped when should_create_issue=false and no follow-up", async () => {
    const gh = { createIssue: vi.fn(), createComment: vi.fn() };
    const out = { ...baseOutput, should_create_issue: false, is_followup_to_issue: null };
    const r = await writeIssueOrComment(gh as any, "x/y", out, { reporter_name: "Y", attachments: [], message_id: 1 });
    expect(r.kind).toBe("skipped");
    expect(gh.createIssue).not.toHaveBeenCalled();
    expect(gh.createComment).not.toHaveBeenCalled();
  });

  it("renders attachment links and voice transcription when present, with English labels", async () => {
    const gh = { createIssue: vi.fn(async () => ({ number: 1, html_url: "u" })), createComment: vi.fn() };
    await writeIssueOrComment(gh as any, "x/y", baseOutput, {
      reporter_name: "Y", message_id: 1,
      attachments: [
        { kind: "photo", telegram_file_id: "p", signed_url: "https://gcs/p.jpg" },
        { kind: "voice", telegram_file_id: "v", signed_url: "https://gcs/v.ogg", transcription: "hello world" },
      ],
    });
    const body = ((gh.createIssue.mock.calls as any[])[0]![1] as any).body;
    expect(body).toContain("https://gcs/p.jpg");
    expect(body).toContain("hello world");
    expect(body).toContain("🎙️");
    expect(body).toContain("**Media:**");
    expect(body).toContain("![Screenshot]");
    expect(body).toContain("[Original recording]");
  });

  it("renders the sensitive warning in English when output.sensitive is true", async () => {
    const gh = { createIssue: vi.fn(async () => ({ number: 1, html_url: "u" })), createComment: vi.fn() };
    const out = { ...baseOutput, sensitive: true };
    await writeIssueOrComment(gh as any, "x/y", out, { reporter_name: "Y", attachments: [], message_id: 1 });
    const body = ((gh.createIssue.mock.calls as any[])[0]![1] as any).body;
    expect(body).toContain("Sensitive content detected");
    expect(body).not.toMatch(/[֐-׿]/);  // no Hebrew characters
  });
});

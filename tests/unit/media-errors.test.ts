import { describe, it, expect, vi } from "vitest";
import { processAttachments } from "../../src/pipeline/media";

describe("processAttachments error surfacing", () => {
  it("returns errors[] when GCS upload throws, attachment ref still passes through", async () => {
    const tg = {
      getFilePath: vi.fn(async () => "x.jpg"),
      downloadFile: vi.fn(async () => new ArrayBuffer(1)),
    };
    const gcs = { uploadAndSign: vi.fn(async () => { throw new Error("gcs 500"); }) };
    const r = await processAttachments(
      [{ kind: "photo", telegram_file_id: "f" }],
      { tg, gcs, transcribeAudio: vi.fn() }
    );
    expect(r.attachments[0]?.signed_url).toBeUndefined();
    expect(r.attachments[0]?.kind).toBe("photo");
    expect(r.errors).toEqual([
      expect.objectContaining({ kind: "photo", stage: "upload", message: expect.stringContaining("gcs 500") })
    ]);
  });

  it("returns errors[] for transcription failure but keeps the upload", async () => {
    const tg = {
      getFilePath: vi.fn(async () => "v.ogg"),
      downloadFile: vi.fn(async () => new ArrayBuffer(1)),
    };
    const gcs = { uploadAndSign: vi.fn(async () => "https://x.example/v.ogg") };
    const transcribe = vi.fn(async () => { throw new Error("gemini down"); });
    const r = await processAttachments(
      [{ kind: "voice", telegram_file_id: "v" }],
      { tg, gcs, transcribeAudio: transcribe }
    );
    expect(r.attachments[0]?.signed_url).toBe("https://x.example/v.ogg");
    expect(r.attachments[0]?.transcription).toBeUndefined();
    expect(r.errors).toEqual([
      expect.objectContaining({ kind: "voice", stage: "transcribe", message: expect.stringContaining("gemini down") })
    ]);
  });

  it("returns empty errors[] on all-success", async () => {
    const tg = {
      getFilePath: vi.fn(async () => "x.jpg"),
      downloadFile: vi.fn(async () => new ArrayBuffer(1)),
    };
    const gcs = { uploadAndSign: vi.fn(async () => "u") };
    const r = await processAttachments(
      [{ kind: "photo", telegram_file_id: "f" }],
      { tg, gcs, transcribeAudio: vi.fn() }
    );
    expect(r.errors).toEqual([]);
  });
});

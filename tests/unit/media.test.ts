import { describe, it, expect, vi } from "vitest";
import { processAttachments } from "../../src/pipeline/media";

describe("processAttachments", () => {
  it("uploads photo to GCS and returns signed URL", async () => {
    const tg = {
      getFilePath: vi.fn(async () => "photos/abc.jpg"),
      downloadFile: vi.fn(async () => new TextEncoder().encode("img").buffer as ArrayBuffer),
    };
    const gcs = { uploadAndSign: vi.fn(async () => "https://signed.example/abc.jpg") };
    const res = await processAttachments(
      [{ kind: "photo", telegram_file_id: "fid" }],
      { tg, gcs, transcribeAudio: vi.fn() }
    );
    expect(res.attachments[0]).toMatchObject({ kind: "photo", signed_url: "https://signed.example/abc.jpg" });
    expect(res.errors).toEqual([]);
    expect(gcs.uploadAndSign).toHaveBeenCalled();
  });

  it("transcribes a voice note and stores both audio + transcription", async () => {
    const tg = {
      getFilePath: vi.fn(async () => "voice/v.ogg"),
      downloadFile: vi.fn(async () => new TextEncoder().encode("ogg").buffer as ArrayBuffer),
    };
    const gcs = { uploadAndSign: vi.fn(async () => "https://signed.example/v.ogg") };
    const transcribe = vi.fn(async () => "transcribed text");
    const res = await processAttachments(
      [{ kind: "voice", telegram_file_id: "vid" }],
      { tg, gcs, transcribeAudio: transcribe }
    );
    expect(res.attachments[0]).toMatchObject({
      kind: "voice", transcription: "transcribed text", signed_url: "https://signed.example/v.ogg",
    });
    expect(res.errors).toEqual([]);
    expect(transcribe).toHaveBeenCalled();
  });

  it("falls back gracefully when transcription throws (now in errors[])", async () => {
    const tg = {
      getFilePath: vi.fn(async () => "v.ogg"),
      downloadFile: vi.fn(async () => new ArrayBuffer(1)),
    };
    const gcs = { uploadAndSign: vi.fn(async () => "https://x.example/v.ogg") };
    const transcribe = vi.fn(async () => { throw new Error("gemini down"); });
    const res = await processAttachments(
      [{ kind: "voice", telegram_file_id: "v" }],
      { tg, gcs, transcribeAudio: transcribe }
    );
    expect(res.attachments[0]?.transcription).toBeUndefined();
    expect(res.attachments[0]?.signed_url).toBe("https://x.example/v.ogg");
    expect(res.errors).toHaveLength(1);
  });

  it("passes through original ref when GCS upload throws", async () => {
    const tg = {
      getFilePath: vi.fn(async () => "x.jpg"),
      downloadFile: vi.fn(async () => new ArrayBuffer(1)),
    };
    const gcs = { uploadAndSign: vi.fn(async () => { throw new Error("gcs 500"); }) };
    const res = await processAttachments(
      [{ kind: "photo", telegram_file_id: "f" }],
      { tg, gcs, transcribeAudio: vi.fn() }
    );
    expect(res.attachments[0]?.signed_url).toBeUndefined();
    expect(res.attachments[0]?.kind).toBe("photo");
    expect(res.errors).toHaveLength(1);
  });
});

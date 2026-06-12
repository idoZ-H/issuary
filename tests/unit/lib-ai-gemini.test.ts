import { describe, it, expect, vi } from "vitest";
import { transcribeWithGemini } from "../../src/lib/ai";

describe("transcribeWithGemini", () => {
  it("posts audio to Gemini and returns transcribed text", async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "הכפתור של הייצוא לא עובד" }] } }],
    })));

    const audio = new TextEncoder().encode("ogg-bytes").buffer as ArrayBuffer;
    const text = await transcribeWithGemini(audio, "audio/ogg", "API-KEY", fakeFetch as unknown as typeof fetch);
    expect(text).toBe("הכפתור של הייצוא לא עובד");
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("throws when Gemini returns no candidates", async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ candidates: [] })));
    await expect(transcribeWithGemini(new ArrayBuffer(1), "audio/ogg", "K", fakeFetch as unknown as typeof fetch))
      .rejects.toThrow(/no transcription/i);
  });

  it("includes the API key in the URL and an inline_data part", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    });
    await transcribeWithGemini(new TextEncoder().encode("a").buffer as ArrayBuffer, "audio/ogg", "MYKEY", fakeFetch as unknown as typeof fetch);
    expect(capturedUrl).toContain("key=MYKEY");
    expect(capturedBody.contents[0].parts[1].inline_data.mime_type).toBe("audio/ogg");
    expect(typeof capturedBody.contents[0].parts[1].inline_data.data).toBe("string");
  });
});

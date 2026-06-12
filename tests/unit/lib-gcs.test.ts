import { describe, it, expect, vi } from "vitest";
import { GcsClient } from "../../src/lib/gcs";

const FAKE_KEY = {
  type: "service_account",
  client_email: "test@test.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  private_key_id: "kid",
  token_uri: "https://oauth2.googleapis.com/token",
};

describe("GcsClient", () => {
  it("uploads a buffer and returns a signed URL", async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok-123", expires_in: 3600 }));
      }
      if (url.includes("storage.googleapis.com/upload/storage/v1")) {
        return new Response(JSON.stringify({ name: "media/voice-abc.ogg" }));
      }
      return new Response("", { status: 404 });
    });

    const client = new GcsClient(JSON.stringify(FAKE_KEY), "workfluxs-feedback-media", {
      fetcher: fakeFetch as unknown as typeof fetch,
      signer: async () => "fake-signature",
    });

    const url = await client.uploadAndSign("voice-abc.ogg", new Uint8Array([1, 2, 3]).buffer, "audio/ogg");

    expect(url).toContain("https://storage.googleapis.com/workfluxs-feedback-media/voice-abc.ogg?");
    expect(url).toContain("X-Goog-Signature=");
    expect(fakeFetch).toHaveBeenCalled();
  });

  it("caches the access token across calls within its TTL", async () => {
    let tokenCalls = 0;
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        tokenCalls++;
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      return new Response(JSON.stringify({ name: "x" }));
    });
    const client = new GcsClient(JSON.stringify(FAKE_KEY), "b", {
      fetcher: fakeFetch as unknown as typeof fetch,
      signer: async () => "sig",
    });
    await client.uploadAndSign("a.bin", new ArrayBuffer(1), "application/octet-stream");
    await client.uploadAndSign("b.bin", new ArrayBuffer(1), "application/octet-stream");
    expect(tokenCalls).toBe(1);
  });

  it("throws when the upload responds non-2xx", async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      return new Response("nope", { status: 500 });
    });
    const client = new GcsClient(JSON.stringify(FAKE_KEY), "b", {
      fetcher: fakeFetch as unknown as typeof fetch,
      signer: async () => "sig",
    });
    await expect(client.uploadAndSign("x", new ArrayBuffer(1), "audio/ogg"))
      .rejects.toThrow(/gcs upload failed: 500/);
  });
});

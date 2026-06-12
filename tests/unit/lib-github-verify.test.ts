import { describe, it, expect } from "vitest";
import { verifyGitHubSignature } from "../../src/lib/github";

const SECRET = "github-secret";

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifyGitHubSignature", () => {
  it("accepts a request with a valid signature", async () => {
    const body = JSON.stringify({ action: "closed" });
    const sig = await sign(SECRET, body);
    const ok = await verifyGitHubSignature(body, sig, SECRET);
    expect(ok).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ action: "closed" });
    const sig = await sign(SECRET, body);
    const ok = await verifyGitHubSignature(body + "x", sig, SECRET);
    expect(ok).toBe(false);
  });

  it("rejects a missing signature", async () => {
    const ok = await verifyGitHubSignature("{}", null, SECRET);
    expect(ok).toBe(false);
  });

  it("rejects a header without sha256= prefix", async () => {
    const ok = await verifyGitHubSignature("{}", "deadbeef", SECRET);
    expect(ok).toBe(false);
  });
});

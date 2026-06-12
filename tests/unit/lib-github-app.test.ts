import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getInstallationToken, GitHubClient } from "../../src/lib/github";

const FAKE_PEM = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";

beforeEach(() => {
  (env as any).GITHUB_APP_ID = "12345";
  (env as any).GITHUB_APP_PRIVATE_KEY = FAKE_PEM;
});

describe("getInstallationToken", () => {
  it("exchanges App JWT for an installation token and caches it", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/repos/x/y/installation")) {
        return new Response(JSON.stringify({ id: 999 }));
      }
      if (url.endsWith("/app/installations/999/access_tokens")) {
        return new Response(JSON.stringify({
          token: "ghs_fake",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }));
      }
      return new Response("nope", { status: 404 });
    });
    const token = await getInstallationToken(env as any, "x/y", {
      fetcher: fetcher as unknown as typeof fetch,
      signer: async () => "sig",
    });
    expect(token).toBe("ghs_fake");
    expect(calls).toEqual([
      "https://api.github.com/repos/x/y/installation",
      "https://api.github.com/app/installations/999/access_tokens",
    ]);

    // Second call should hit cache only.
    calls.length = 0;
    const token2 = await getInstallationToken(env as any, "x/y", {
      fetcher: fetcher as unknown as typeof fetch,
      signer: async () => "sig",
    });
    expect(token2).toBe("ghs_fake");
    expect(calls.length).toBe(0);
  });

  it("throws a clear 'install the App' error on 404 installation", async () => {
    const fetcher = vi.fn(async () => new Response("not found", { status: 404 }));
    await expect(getInstallationToken(env as any, "uninstalled/repo", {
      fetcher: fetcher as unknown as typeof fetch,
      signer: async () => "sig",
    })).rejects.toThrow(/no installation found.*uninstalled\/repo/i);
  });

  it("re-fetches when the cached token is within 60s of expiry", async () => {
    let tokenCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 1 }));
      if (url.includes("/access_tokens")) {
        tokenCalls++;
        // Return tokens that expire 30s from now — should NOT be cached.
        return new Response(JSON.stringify({
          token: `ghs_${tokenCalls}`,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        }));
      }
      return new Response("", { status: 404 });
    });
    const t1 = await getInstallationToken(env as any, "y/z", {
      fetcher: fetcher as unknown as typeof fetch,
      signer: async () => "sig",
    });
    const t2 = await getInstallationToken(env as any, "y/z", {
      fetcher: fetcher as unknown as typeof fetch,
      signer: async () => "sig",
    });
    expect(t1).toBe("ghs_1");
    expect(t2).toBe("ghs_2");
  });
});

describe("GitHubClient.forRepo", () => {
  it("acquires an installation token and returns a client that requests with it", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("Authorization");
      seen.push({ url, auth });
      if (url.endsWith("/repos/o/r/installation")) return new Response(JSON.stringify({ id: 7 }));
      if (url.endsWith("/app/installations/7/access_tokens")) {
        return new Response(JSON.stringify({
          token: "ghs_forrepo",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }));
      }
      if (url.endsWith("/repos/o/r/issues")) {
        return new Response(JSON.stringify({ number: 42, html_url: "https://gh/issues/42" }));
      }
      return new Response("nope", { status: 404 });
    });

    const gh = await GitHubClient.forRepo(env as any, "o/r", {
      fetcher: fetcher as unknown as typeof fetch,
      signer: async () => "sig",
    });
    const issue = await gh.createIssue("o/r", { title: "t", body: "b", labels: [] });

    expect(issue.number).toBe(42);
    // The subsequent API call carries the freshly-acquired installation token.
    const issueCall = seen.find((s) => s.url.endsWith("/repos/o/r/issues"));
    expect(issueCall?.auth).toBe("Bearer ghs_forrepo");
  });
});

import type { Env } from "../types";

type FetchLike = typeof fetch;

export async function verifyGitHubSignature(
  rawBody: string,
  headerValue: string | null,
  secret: string
): Promise<boolean> {
  if (!headerValue || !headerValue.startsWith("sha256=")) return false;
  const expected = headerValue.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (computed.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

export interface GitHubClientOpts {
  retryDelayMs?: number;
}

export interface CodeMatch { path: string; snippet: string; url: string }
export interface IssueMatch { number: number; title: string; state: "open" | "closed"; labels: string[]; updated_at: string; url: string }

export class GitHubClient {
  private readonly retryDelayMs: number;
  private readonly fetcher: FetchLike;
  constructor(private readonly token: string, fetcher: FetchLike = fetch, opts: GitHubClientOpts = {}) {
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    // See TelegramClient: wrap to detach `this` so global fetch doesn't throw.
    this.fetcher = (input, init) => fetcher(input, init);
  }

  // Acquire a repo-scoped client in one step: fetch the GitHub App installation
  // token (cached in KV) and wire a client to use it. The same optional fetcher/
  // signer serves both token acquisition and subsequent API calls, so tests can
  // inject one fake. Callers that already hold a token use `new GitHubClient(...)`.
  static async forRepo(env: Env, repo: string, opts: ForRepoOpts = {}): Promise<GitHubClient> {
    const token = await getInstallationToken(env, repo, {
      fetcher: opts.fetcher,
      signer: opts.signer,
      now: opts.now,
    });
    return new GitHubClient(token, opts.fetcher ?? fetch, { retryDelayMs: opts.retryDelayMs });
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.fetcher(url, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "issuary",
          ...(init.headers ?? {}),
        },
      });
      if (res.status < 500 && res.status !== 429) return res;
      lastErr = await res.text();
      await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
    }
    throw new Error(`github request failed after retries: ${lastErr}`);
  }

  async searchCode(repo: string, query: string): Promise<{ matches: CodeMatch[]; total: number; truncated: boolean }> {
    const q = encodeURIComponent(`${query} repo:${repo}`);
    const res = await this.request(`/search/code?q=${q}&per_page=5`);
    if (!res.ok) throw new Error(`searchCode: ${res.status}`);
    const json = (await res.json()) as { items?: any[]; total_count?: number };
    const matches: CodeMatch[] = (json.items ?? []).slice(0, 5).map((it: any) => ({
      path: it.path,
      snippet: (it.text_matches?.[0]?.fragment ?? "").slice(0, 200),
      url: it.html_url,
    }));
    return { matches, total: json.total_count ?? matches.length, truncated: (json.total_count ?? 0) > 5 };
  }

  async searchIssues(repo: string, query: string, state: "open" | "closed" | "all"): Promise<{ matches: IssueMatch[]; total: number; truncated: boolean }> {
    const stateClause = state === "all" ? "" : ` state:${state}`;
    const q = encodeURIComponent(`${query} repo:${repo} is:issue${stateClause}`);
    const res = await this.request(`/search/issues?q=${q}&per_page=5`);
    if (!res.ok) throw new Error(`searchIssues: ${res.status}`);
    const json = (await res.json()) as { items?: any[]; total_count?: number };
    const matches: IssueMatch[] = (json.items ?? []).slice(0, 5).map((it: any) => ({
      number: it.number,
      title: it.title,
      state: it.state,
      labels: (it.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)),
      updated_at: it.updated_at,
      url: it.html_url,
    }));
    return { matches, total: json.total_count ?? matches.length, truncated: (json.total_count ?? 0) > 5 };
  }

  async readFile(repo: string, path: string): Promise<{ path: string; content: string; size_bytes: number; truncated: boolean }> {
    const res = await this.request(`/repos/${repo}/contents/${encodeURIComponent(path)}`);
    if (!res.ok) {
      if (res.status === 404) return { path, content: "", size_bytes: 0, truncated: false };
      throw new Error(`readFile: ${res.status}`);
    }
    const json = (await res.json()) as { encoding?: string; content?: string; size?: number };
    if (json.encoding !== "base64" || typeof json.content !== "string") {
      return { path, content: "", size_bytes: json.size ?? 0, truncated: false };
    }
    let decoded = atob(json.content.replace(/\n/g, ""));
    let truncated = false;
    if (decoded.length > 10_000) {
      decoded = decoded.slice(0, 10_000);
      truncated = true;
    }
    return { path, content: decoded, size_bytes: json.size ?? decoded.length, truncated };
  }

  async createIssue(repo: string, args: { title: string; body: string; labels: string[] }): Promise<{ number: number; html_url: string }> {
    const res = await this.request(`/repos/${repo}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`createIssue: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { number: number; html_url: string };
    return { number: json.number, html_url: json.html_url };
  }

  async createComment(repo: string, issueNumber: number, body: string): Promise<void> {
    const res = await this.request(`/repos/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`createComment: ${res.status} ${await res.text()}`);
  }

  async getRepoTree(repo: string, opts: { maxFiles?: number } = {}): Promise<string[]> {
    try {
      return (await this.getRepoTreeDetailed(repo, opts)).map((t) => t.path);
    } catch {
      // Degraded fallback — top-level contents only, with the legacy "file "/
      // "dir " display prefix. This feeds ONLY the classifier's directory
      // listing. The sha-diff callers get the throw instead (see below), so a
      // transient tree failure can never masquerade as "every file removed" and
      // wipe the index.
      const res = await this.request(`/repos/${repo}/contents/`);
      if (!res.ok) return [];
      const json = (await res.json()) as Array<{ type?: string; path: string }>;
      return (json ?? []).map((it) => `${it.type === "dir" ? "dir" : "file"} ${it.path}`);
    }
  }

  async getRepoTreeDetailed(repo: string, opts: { maxFiles?: number } = {}): Promise<Array<{ path: string; sha: string }>> {
    // Walk the entire repo via the git trees recursive API. This bypasses the
    // GitHub code-search index, which lags badly on private repos (often empty
    // for hours after a repo is created), and gives the classifier an
    // authoritative file map to ground issue bodies against.
    //
    // Each blob carries a content-addressed `sha` (the git blob SHA): a free
    // change hash that drives incremental index updates. Unlike getRepoTree,
    // this THROWS on failure rather than returning a degraded contents listing —
    // the diff/incremental callers must never treat a transient API failure as a
    // valid (empty) tree, which would delete every vector in the index.
    const max = opts.maxFiles ?? 300;
    const noise = /(^|\/)(node_modules|\.git|dist|build|\.next|\.wrangler|coverage|\.turbo)\/|\.(lock|map|min\.js|min\.css)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

    const repoRes = await this.request(`/repos/${repo}`);
    if (!repoRes.ok) throw new Error(`repo metadata: ${repoRes.status}`);
    const info = (await repoRes.json()) as { default_branch?: string };
    const branch = info.default_branch ?? "main";

    const treeRes = await this.request(`/repos/${repo}/git/trees/${branch}?recursive=1`);
    if (!treeRes.ok) throw new Error(`tree: ${treeRes.status}`);
    const tree = (await treeRes.json()) as { tree?: Array<{ path: string; type: string; sha: string }>; truncated?: boolean };

    return (tree.tree ?? [])
      .filter((it) => it.type === "blob" && it.path && !noise.test(it.path))
      .map((it) => ({ path: it.path, sha: it.sha ?? "" }))
      .slice(0, max);
  }

  async getReadme(repo: string): Promise<string> {
    const res = await this.request(`/repos/${repo}/readme`);
    if (!res.ok) return "";
    const json = (await res.json()) as { encoding?: string; content?: string };
    if (json.encoding !== "base64" || !json.content) return "";
    return atob(json.content.replace(/\n/g, "")).slice(0, 3072);
  }

  async listRecentIssues(repo: string): Promise<Array<{ number: number; title: string; labels: string[]; state: "open" | "closed" }>> {
    const res = await this.request(`/repos/${repo}/issues?state=open&per_page=20&sort=updated`);
    if (!res.ok) return [];
    const json = (await res.json()) as Array<any>;
    return (json ?? []).filter((it: any) => !it.pull_request).map((it: any) => ({
      number: it.number,
      title: it.title,
      labels: (it.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)),
      state: it.state,
    }));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GitHub App auth: JWT → installation lookup → installation access token.
// Tokens are 1h. We cache in RATE_LIMITS KV under `ghtoken:<repo>` and
// re-fetch when the cached entry has under 60s of slack remaining.

type Signer = (data: string, privateKeyPem: string) => Promise<string>;

export interface InstallationTokenOpts {
  fetcher?: FetchLike;
  signer?: Signer;
  now?: () => number;
}

// Options for GitHubClient.forRepo: the token-acquisition opts plus the client's
// own request opts. The fetcher is shared across both phases.
export interface ForRepoOpts extends InstallationTokenOpts {
  retryDelayMs?: number;
}

interface CachedToken { token: string; expires_at: number }

const TOKEN_CACHE_PREFIX = "ghtoken:";

function b64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Wrap a PKCS#1 RSAPrivateKey DER blob in a PKCS#8 PrivateKeyInfo so
// crypto.subtle.importKey can accept it. GitHub Apps emit "BEGIN RSA PRIVATE
// KEY" PEMs (PKCS#1); Web Crypto only takes PKCS#8.
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);              // INTEGER 0
  const algId = new Uint8Array([                                   // SEQUENCE { rsaEncryption, NULL }
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const oct = new Uint8Array(4 + pkcs1.length);                    // OCTET STRING wrapping pkcs1
  oct[0] = 0x04; oct[1] = 0x82;
  oct[2] = (pkcs1.length >> 8) & 0xff; oct[3] = pkcs1.length & 0xff;
  oct.set(pkcs1, 4);
  const innerLen = version.length + algId.length + oct.length;
  const out = new Uint8Array(4 + innerLen);                        // SEQUENCE wrapping all
  out[0] = 0x30; out[1] = 0x82;
  out[2] = (innerLen >> 8) & 0xff; out[3] = innerLen & 0xff;
  let off = 4;
  out.set(version, off); off += version.length;
  out.set(algId, off); off += algId.length;
  out.set(oct, off);
  return out;
}

async function defaultSigner(data: string, privateKeyPem: string): Promise<string> {
  const isPkcs1 = privateKeyPem.includes("BEGIN RSA PRIVATE KEY");
  const stripped = privateKeyPem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  let der: Uint8Array = Uint8Array.from(atob(stripped), (c) => c.charCodeAt(0));
  if (isPkcs1) der = pkcs1ToPkcs8(der);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(data));
  return b64url(sig);
}

async function buildAppJwt(appId: string, privateKeyPem: string, signer: Signer, now: () => number): Promise<string> {
  const iat = Math.floor(now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  // iat back-dated 60s to absorb clock skew; exp at 9 minutes (max GitHub allows is 10).
  const payload = { iat: iat - 60, exp: iat + 540, iss: appId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = await signer(signingInput, privateKeyPem);
  return `${signingInput}.${signature}`;
}

export async function getInstallationToken(
  env: Env,
  repo: string,
  opts: InstallationTokenOpts = {}
): Promise<string> {
  const fetcher = opts.fetcher ?? fetch;
  const signer = opts.signer ?? defaultSigner;
  const now = opts.now ?? (() => Date.now());

  const cacheKey = `${TOKEN_CACHE_PREFIX}${repo}`;
  const cached = await env.RATE_LIMITS.get<CachedToken>(cacheKey, "json");
  if (cached && cached.expires_at > now() + 60_000) {
    return cached.token;
  }

  const jwt = await buildAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, signer, now);
  const ghHeaders = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "issuary",
  };

  const instRes = await fetcher(`https://api.github.com/repos/${repo}/installation`, { headers: ghHeaders });
  if (!instRes.ok) {
    throw new Error(
      `github app: no installation found for ${repo} (HTTP ${instRes.status}). ` +
      `Install the App on this repo first.`
    );
  }
  const inst = (await instRes.json()) as { id: number };

  const tokRes = await fetcher(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
    method: "POST",
    headers: ghHeaders,
  });
  if (!tokRes.ok) {
    throw new Error(`github app: token exchange failed (HTTP ${tokRes.status})`);
  }
  const tok = (await tokRes.json()) as { token: string; expires_at: string };
  const expiresAt = new Date(tok.expires_at).getTime();

  await env.RATE_LIMITS.put(
    cacheKey,
    JSON.stringify({ token: tok.token, expires_at: expiresAt } satisfies CachedToken),
    { expirationTtl: 60 * 60 }
  );
  return tok.token;
}

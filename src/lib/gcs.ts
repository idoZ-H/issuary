type FetchLike = typeof fetch;
type Signer = (data: string, privateKeyPem: string) => Promise<string>;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

const SIGNED_URL_TTL_S = 90 * 24 * 60 * 60;

function b64url(input: string | ArrayBuffer): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function defaultSigner(data: string, privateKeyPem: string): Promise<string> {
  const pem = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(data)
  );
  return b64url(sig);
}

export interface GcsClientOptions {
  fetcher?: FetchLike;
  signer?: Signer;
  now?: () => number;
}

export class GcsClient {
  private readonly key: ServiceAccountKey;
  private readonly fetcher: FetchLike;
  private readonly signer: Signer;
  private readonly now: () => number;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(serviceAccountJson: string, private readonly bucket: string, opts: GcsClientOptions = {}) {
    this.key = JSON.parse(serviceAccountJson);
    // Wrap to detach `this` so global fetch doesn't throw "Illegal invocation".
    const f = opts.fetcher ?? fetch;
    this.fetcher = (input, init) => f(input, init);
    this.signer = opts.signer ?? defaultSigner;
    this.now = opts.now ?? (() => Date.now());
  }

  async uploadAndSign(objectName: string, body: ArrayBuffer, contentType: string): Promise<string> {
    const token = await this.getAccessToken();
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    const res = await this.fetcher(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
      body,
    });
    if (!res.ok) throw new Error(`gcs upload failed: ${res.status} ${await res.text()}`);
    return await this.signUrl(objectName);
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now() + 60_000) {
      return this.cachedToken.token;
    }
    const iat = Math.floor(this.now() / 1000);
    const claim = {
      iss: this.key.client_email,
      scope: "https://www.googleapis.com/auth/devstorage.read_write",
      aud: this.key.token_uri,
      exp: iat + 3600,
      iat,
    };
    const header = { alg: "RS256", typ: "JWT" };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
    const signature = await this.signer(signingInput, this.key.private_key);
    const jwt = `${signingInput}.${signature}`;
    const tokRes = await this.fetcher(this.key.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
    });
    const tok = (await tokRes.json()) as { access_token?: string; expires_in?: number };
    if (!tok.access_token) throw new Error(`gcs token exchange failed: ${JSON.stringify(tok)}`);
    this.cachedToken = { token: tok.access_token, expiresAt: this.now() + (tok.expires_in ?? 3600) * 1000 };
    return tok.access_token;
  }

  private async signUrl(objectName: string): Promise<string> {
    const expiry = Math.floor(this.now() / 1000) + SIGNED_URL_TTL_S;
    const canonicalRequest = `GET\n/${this.bucket}/${objectName}\nExpires=${expiry}&GoogleAccessId=${encodeURIComponent(this.key.client_email)}\nhost:storage.googleapis.com\n\nhost\nUNSIGNED-PAYLOAD`;
    const signature = await this.signer(canonicalRequest, this.key.private_key);
    const params = new URLSearchParams({
      "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
      "X-Goog-Credential": this.key.client_email,
      "X-Goog-Date": String(expiry),
      "X-Goog-Expires": String(SIGNED_URL_TTL_S),
      "X-Goog-Signature": signature,
    });
    return `https://storage.googleapis.com/${this.bucket}/${objectName}?${params.toString()}`;
  }
}

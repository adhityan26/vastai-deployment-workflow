import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SignJWT, exportJWK, exportSPKI, generateKeyPair, type JWK } from "jose";

// A fake OpenID provider for tests: discovery, JWKS and a token endpoint served by a local HTTP
// server, with real RS256 keys from jose. It behaves like Authentik for the authorization code flow
// with PKCE: `authorize()` stands in for the browser round trip (it reads state, nonce and the PKCE
// challenge from the authorize URL and returns a one-time code), and the token endpoint checks the
// client credentials, redirect_uri and code_verifier before minting an ID token for that code.

export const CLIENT_ID = "vast-web";
export const CLIENT_SECRET = "fake-client-secret-0123456789abcdef";
const KID = "fake-k1";
const ISSUER_PATH = "/application/o/vast/";

export interface TokenRequest {
  readonly form: Record<string, string>;
  readonly authorization: string | undefined;
}

export type TokenOverride = (req: TokenRequest) => { status: number; body: string; headers?: Record<string, string> } | undefined;

interface PendingCode {
  nonce: string;
  challenge: string;
  method: string;
  redirectUri: string;
  clientId: string;
  claims: Record<string, unknown>;
  makeIdToken?: (nonce: string) => Promise<string>;
}

export interface MintOptions {
  key?: CryptoKey;
  alg?: string;
  iss?: string;
  aud?: string | string[];
  /** Absolute exp (seconds) or a jose duration; null omits exp. */
  exp?: string | number | null;
  sub?: string | null;
  nonce?: string | null;
  claims?: Record<string, unknown>;
}

export interface FakeIdp {
  readonly base: string;
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly signing: CryptoKey;
  readonly otherKey: CryptoKey;
  readonly publicPem: string;
  readonly tokenRequests: TokenRequest[];
  /** How many times the discovery document was requested. */
  discoveryHits: number;
  /** Replace (or patch) the discovery document; a number answers with that HTTP status instead. */
  discovery: Record<string, unknown> | number;
  /** Intercept the token endpoint; return undefined to fall through to the normal flow. */
  tokenOverride: TokenOverride | undefined;
  /** Simulate the browser login: returns the code and the state the provider would send back. */
  authorize(authorizeUrl: string, claims?: Record<string, unknown>, opts?: { idToken?: (nonce: string) => Promise<string> }): { code: string; state: string };
  mint(opts?: MintOptions): Promise<string>;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  const codes = new Map<string, PendingCode>();
  let counter = 0;

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, "{}"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake idp has no port");
  const base = `http://127.0.0.1:${address.port}`;
  const issuer = `${base}${ISSUER_PATH}`;

  const idp: FakeIdp = {
    base,
    issuer,
    discoveryUrl: `${base}${ISSUER_PATH}.well-known/openid-configuration`,
    signing: pair.privateKey,
    otherKey: other.privateKey,
    publicPem: await exportSPKI(pair.publicKey),
    tokenRequests: [],
    discoveryHits: 0,
    discovery: {
      issuer,
      authorization_endpoint: `${base}/application/o/authorize/`,
      token_endpoint: `${base}/application/o/token/`,
      jwks_uri: `${base}${ISSUER_PATH}jwks/`,
      code_challenge_methods_supported: ["plain", "S256"],
    },
    tokenOverride: undefined,
    authorize(authorizeUrl, claims = {}, opts = {}) {
      const url = new URL(authorizeUrl);
      const p = url.searchParams;
      const code = `code-${++counter}-${Math.random().toString(36).slice(2)}`;
      const pending: PendingCode = {
        nonce: p.get("nonce") ?? "",
        challenge: p.get("code_challenge") ?? "",
        method: p.get("code_challenge_method") ?? "",
        redirectUri: p.get("redirect_uri") ?? "",
        clientId: p.get("client_id") ?? "",
        claims,
        ...(opts.idToken ? { makeIdToken: opts.idToken } : {}),
      };
      codes.set(code, pending);
      return { code, state: p.get("state") ?? "" };
    },
    async mint(o: MintOptions = {}) {
      const payload: Record<string, unknown> = {
        preferred_username: "ayu",
        email: "ayu@example.test",
        name: "Ayu",
        groups: ["member"],
        ...(o.claims ?? {}),
      };
      if (o.nonce !== null && o.nonce !== undefined) payload["nonce"] = o.nonce;
      const jwt = new SignJWT(payload)
        .setProtectedHeader({ alg: o.alg ?? "RS256", kid: KID })
        .setIssuer(o.iss ?? issuer)
        .setAudience(o.aud ?? CLIENT_ID)
        .setIssuedAt();
      if (o.exp !== null) jwt.setExpirationTime(o.exp ?? "5m");
      if (o.sub !== null) jwt.setSubject(o.sub ?? "user-1");
      return jwt.sign(o.key ?? pair.privateKey);
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", base).pathname;
    if (req.method === "GET" && path === `${ISSUER_PATH}.well-known/openid-configuration`) {
      idp.discoveryHits += 1;
      if (typeof idp.discovery === "number") return send(res, idp.discovery, "{}");
      return send(res, 200, JSON.stringify(idp.discovery));
    }
    if (req.method === "GET" && path === `${ISSUER_PATH}jwks/`) return send(res, 200, JSON.stringify({ keys: [jwk] }));
    if (req.method === "POST" && path === "/application/o/token/") {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      const request: TokenRequest = { form, authorization: req.headers.authorization };
      idp.tokenRequests.push(request);
      const override = idp.tokenOverride?.(request);
      if (override) return send(res, override.status, override.body, override.headers);
      const pending = codes.get(form["code"] ?? "");
      codes.delete(form["code"] ?? ""); // one-time codes: a replay finds nothing
      const verifierOk =
        pending !== undefined &&
        pending.method === "S256" &&
        createHash("sha256").update(form["code_verifier"] ?? "", "ascii").digest("base64url") === pending.challenge;
      if (
        form["grant_type"] !== "authorization_code" ||
        pending === undefined ||
        form["client_id"] !== CLIENT_ID ||
        form["client_secret"] !== CLIENT_SECRET ||
        pending.clientId !== CLIENT_ID ||
        form["redirect_uri"] !== pending.redirectUri ||
        !verifierOk
      ) {
        return send(res, 400, JSON.stringify({ error: "invalid_grant", error_description: "provider detail text" }));
      }
      const idToken = pending.makeIdToken
        ? await pending.makeIdToken(pending.nonce)
        : await idp.mint({ nonce: pending.nonce, claims: pending.claims });
      return send(res, 200, JSON.stringify({ access_token: "fake-access-token", token_type: "Bearer", id_token: idToken }));
    }
    send(res, 404, "{}");
  }

  return idp;
}

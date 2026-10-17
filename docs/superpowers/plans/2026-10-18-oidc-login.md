# OIDC Login (Authentik) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Authentik proxy-outpost JWT header auth of the web service with an in-app OIDC login (a login page whose button redirects to Authentik, like the owner's `dashboard.3dprintingbandung.my.id`), exposed through a Cloudflare tunnel straight to the container.

**Architecture:** `apps/web` gets an OIDC relying-party (authorization code + PKCE, server-side code exchange, ID token verified with `jose`) and a signed session cookie. The existing `Auth` interface (`identify(headers) -> Identity | null`, `role(identity)`) is kept, so `server.ts` and `routes.ts` keep their gate unchanged; `identify` now reads the session cookie. New public routes `/auth/login`, `/auth/callback`, `/auth/logout`. Groups come from the ID token `groups` claim at login time.

**Tech Stack:** Node 20+, TypeScript strict, Fastify, `jose`, Vitest (fake IdP HTTP server in tests).

**Spec:** `docs/superpowers/specs/2026-10-17-web-interface-design.md` (section 4 is superseded by this plan: Authentik is still the only login and groups `authentik Admins` / `member` still decide the role, but the mechanism is OIDC in the app instead of the outpost JWT header). Reference implementation of the owner's pattern: `/Users/adhityatangahu/Documents/shopee-analysis/apps/dashboard/lib/auth.ts` (NextAuth Authentik provider; issuer `https://auth.3dprintingbandung.my.id/application/o/<slug>/`).

## Global Constraints

- Everything from `docs/superpowers/plans/2026-10-17-web-interface.md` "Global Constraints" still applies: no hardcoded config (all values from `contracts/config-schema.yaml` component `apps`, env read only in `apps/core/src/config.ts`; lint `python3 scripts/check_config_usage.py apps instance`), no secrets in the repo/logs/errors/browser, English comments and commit messages, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (opus implementers use their own model name), never `--no-verify`, never `git add -f` anything under `.superpowers`.
- **Default deny:** no valid session -> 401 on `/api/*`; valid session whose groups map to role `none` -> 403. Fail closed when any OIDC config key is empty (every identify returns null, loud message at startup).
- **ID token:** accept only RS256/ES256 (pinned list); require `iss` = discovered issuer, `aud` = `AUTHENTIK_CLIENT_ID`, `exp`, `sub`, `nonce` equal to the one stored for this login; zero clock tolerance beyond a small configured skew (default 0). Authorization code flow with PKCE S256 and a per-login `state`; the code exchange is server-side with the client secret.
- **Session cookie:** HttpOnly, `Secure` (derived from `WEB_PUBLIC_URL` being https; allow non-Secure only for http://localhost), `SameSite=Lax`, `Path=/`, name from a constant, signed (HS256 or HMAC-SHA256) with `WEB_SESSION_SECRET` (min 32 bytes), expiry `WEB_SESSION_TTL_H` (default 8). It carries only `sub`, `username`, `name`, `email`, `groups`, `iat`, `exp`. A tampered, expired or wrong-signature cookie is anonymous. The login-transaction cookie (state, nonce, PKCE verifier, return path) is a separate short-lived (10 min) signed HttpOnly cookie, cleared on callback.
- **Redirects:** `/auth/login?next=` accepts only same-site relative paths (start with a single `/`, no `//`, no backslash, no scheme); everything else becomes `/`. The `redirect_uri` is built only from `WEB_PUBLIC_URL`, never from request headers.
- **CSRF:** cookie auth makes it relevant. Keep the JSON-only POST rule (415), the `Sec-Fetch-Site` gate, and ADD an `Origin` check on every non-GET `/api/*` and `/auth/logout` request: `Origin` must equal the origin of `WEB_PUBLIC_URL` when present; a POST with neither a matching `Origin` nor `Sec-Fetch-Site: same-origin` is rejected (403).
- **Public routes** are exactly: `/healthz`, static files, `/auth/login`, `/auth/callback`, `/auth/logout`. Everything else under `/api` stays gated.

## Review Focus

1. Login CSRF / state fixation: a callback with a missing/mismatched `state`, a replayed code, or a cookie from another login must not create a session.
2. Open redirect via `next`, and redirect URI built from headers.
3. Forged/tampered/expired session cookie; cookie flags; secret too short.
4. ID token validation gaps (alg none/HS256, wrong aud/iss, missing nonce/exp, groups claim a string).
5. Unconfigured OIDC must fail closed (no accidental open access).

## File Structure

```
apps/web/src/oidc.ts        discovery, authorize URL (state/nonce/PKCE), code exchange, ID token verification
apps/web/src/session.ts     sign/verify session and login-transaction cookies, cookie serialisation
apps/web/src/auth.ts        createAuth(cfg, deps): cookie-session Auth + auth routes' helpers (replaces header-JWT version)
apps/web/src/server.ts      /auth/* routes, Origin check; routes.ts unchanged gate
apps/web/public/{index.html,ui.ts,model.ts,style.css}  login screen, logout button
contracts/config-schema.yaml, contracts/web.openapi.json
docker-compose.yml, .env.example, deploy/web/README.md, apps/web/tests/deploy.test.ts
```

---

### Task 1: OIDC client and session cookies (library level)

**Files:** Create `apps/web/src/oidc.ts`, `apps/web/src/session.ts`, `apps/web/tests/oidc.test.ts`, `apps/web/tests/session.test.ts`; Modify `contracts/config-schema.yaml` (apps): add `AUTHENTIK_CLIENT_ID` (str, default ""), `AUTHENTIK_CLIENT_SECRET` (str, secret, default ""), `WEB_PUBLIC_URL` (str, default ""), `WEB_SESSION_SECRET` (str, secret, default ""), `WEB_SESSION_TTL_H` (int, default 8, min 1, max 168), `WEB_OIDC_SKEW_S` (int, default 0, min 0, max 120); remove `AUTHENTIK_JWKS_URL` and `AUTHENTIK_AUDIENCE`; keep `AUTHENTIK_ISSUER` (default ""). Regenerate nothing on the instance side (apps-only keys); run the Python config tests.

**Interfaces:**
- `oidc.ts`: `createOidc(cfg, deps?: {fetch?: typeof fetch, now?: () => number, jwks?: JWTVerifyGetKey}): Oidc` with `configured: boolean`; `begin(next: string): Promise<{redirectUrl: string, transaction: LoginTransaction}>` (state, nonce, PKCE verifier/challenge S256; endpoints from `<issuer>/.well-known/openid-configuration`, discovered lazily and cached, discovered `issuer` must equal the configured issuer); `finish(params: {code?: string, state?: string, error?: string}, tx: LoginTransaction): Promise<OidcIdentity>` (rejects with `OidcError(code)` — codes: `state_mismatch`, `provider_error`, `exchange_failed`, `token_invalid`, `nonce_mismatch`, `no_subject`; never includes tokens/secrets in messages) where `OidcIdentity = {subject, username, name, email, groups}`; `groups` taken from the verified ID token claim (array of strings only; anything else -> []). `sanitizeNext(next: unknown): string`.
- `session.ts`: `createSessions(secret: string, ttlHours: number, now?)`: `issue(identity): string` (cookie value), `read(cookieHeader: string | undefined): Identity | null`, `serialize(value, {secure}): string` / `clear({secure}): string` (Set-Cookie strings), `issueTransaction(tx): string`, `readTransaction(cookieHeader): LoginTransaction | null`. Throws at construction if the secret is shorter than 32 bytes.
- Test fixtures: a fake IdP (Node http server with discovery, JWKS and token endpoint) and keys generated with jose.

- [ ] **Step 1: Failing tests (names, behaviours):** oidc: `begin builds an authorize URL with state, nonce, PKCE S256 and the exact redirect_uri from WEB_PUBLIC_URL`; `finish accepts a valid code and returns the identity with groups`; `rejects state mismatch / missing state / provider error param`; `rejects wrong issuer, wrong audience, expired, missing exp, nonce mismatch, alg none, HS256 signed with the public key text`; `groups claim as a string or with non-strings is sanitized to []`; `discovery issuer mismatch is rejected`; `token endpoint failure/non-JSON/oversized body -> exchange_failed`; `errors never contain the code, the client secret or tokens`; `sanitizeNext` cases (`/a`, `//evil`, `/\\evil`, `https://x`, `javascript:`, empty, non-string, very long). session: sign/verify round trip; tampered payload, wrong secret, expired, `alg` swapped, garbage cookie, multiple cookies with the same name (reject/ignore ambiguity), cookie flags (HttpOnly, SameSite=Lax, Path=/, Secure when https), clear cookie, secret < 32 bytes throws, transaction cookie expires after 10 minutes.
- [ ] **Step 2:** run `npx vitest run apps/web/tests/oidc.test.ts apps/web/tests/session.test.ts` -> FAIL.
- [ ] **Step 3: Implement** both modules with `jose` (SignJWT/jwtVerify HS256 for cookies; `createRemoteJWKSet` for the ID token keys, injectable). Cap the size of discovery/token responses (reuse the pattern of `apps/core/src/http.ts` or a small local helper) and apply timeouts from config (`HTTP_TIMEOUT_S_APPS`). Update the schema, run `python3 scripts/check_config_usage.py apps instance` and `cd instance/agent && arch -arm64 .venv/bin/python -m pytest -q -W error tests/test_config.py tests/test_contracts.py`.
- [ ] **Step 4:** run the new tests + `npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat: OIDC client and signed session cookies`.

### Task 2: Wire cookie auth, auth routes, Origin check; remove the header-JWT path

**Files:** Modify `apps/web/src/auth.ts`, `apps/web/src/server.ts`, `apps/web/src/routes.ts` (only if needed), `apps/web/src/main.ts`, `contracts/web.openapi.json`, `apps/web/tests/auth.test.ts`, `apps/web/tests/routes.test.ts`, `apps/web/tests/page-server.test.ts`.

**Interfaces:**
- Consumes: Task 1 (`createOidc`, `createSessions`, `sanitizeNext`).
- `createAuth(cfg, deps: {sessions, oidc}, options?)` keeps `{configured, identify(headers), role(identity)}`; `identify` reads the `cookie` header via `sessions.read` (anonymous -> null). `configured` is true only when issuer, client id, client secret, public URL and session secret are all set. Remove the `X-authentik-jwt` handling and its tests.
- New routes (access `public`): `GET /auth/login?next=` -> 302 to the IdP with the login-transaction cookie; `GET /auth/callback` -> on success sets the session cookie, clears the transaction cookie, 302 to the sanitized `next` (default `/`); on any failure 302 to `/?login_error=<code>` (code from a small allowlist, no details) and clears the transaction cookie; unconfigured -> 503 JSON `{error:{code:"auth_not_configured"}}`; `POST /auth/logout` -> clears the session cookie, 204 (Origin check applies). Add `GET /api/me` (member+): `{name, username, role}` (no groups list needed by the page beyond role).
- The Origin/`Sec-Fetch-Site` rule from Global Constraints for non-GET requests; `Referrer-Policy`, CSP etc. stay. The CSP must allow the redirect (navigation is fine; `form-action 'self'` stays since logout is fetch).
- main.ts: build oidc + sessions from config; log loudly and keep failing closed when not configured; no JWKS URL key any more.

- [ ] **Step 1: Failing tests:** routes (with the fake IdP from Task 1 and real sessions): `anonymous /api/state -> 401`; full login flow `login -> callback -> cookie -> /api/state 200 with role`; `callback with wrong state -> redirect with login_error and NO session cookie`; `callback replay (cookie already cleared) -> no session`; `next` open-redirect attempts end at `/`; `member vs admin vs none groups -> 200/403 on admin endpoints and 403 on everything for none`; `tampered/expired session cookie -> 401`; `logout clears the cookie`; `POST /api/start with a cross-site Origin -> 403`, `without Origin but Sec-Fetch-Site same-origin -> allowed`, `with matching Origin -> allowed`, `with neither -> 403`; `unconfigured OIDC -> every /api 401 and /auth/login 503`; `/healthz` and static stay public; `openapi file matches the registered routes` (including the new /auth routes and /api/me); `state/me responses never contain tokens, the session secret or the client secret`.
- [ ] **Step 2:** run -> FAIL. **Step 3: Implement.** **Step 4:** `npx vitest run apps` + `npm run typecheck` + config lint -> PASS. **Step 5: Commit** `feat: cookie-session auth with Authentik OIDC login routes`.

### Task 3: Login screen and logout in the page

**Files:** Modify `apps/web/public/{index.html,ui.ts,model.ts,style.css}`, `apps/web/tests/page/*`, `apps/web/tests/page-server.test.ts`.

**Behaviour:** on load the page calls `GET /api/me`; 401 -> show a login screen (app name, one button "Login with Authentik" linking to `/auth/login?next=/` — a plain link, no inline script) and, when the URL has `?login_error=<code>`, a short human message mapped from the allowlist (`access_denied` -> "This account has no access", others -> "Login failed, try again"); 200 -> the existing app plus a small header showing the user name and a Logout button (`POST /auth/logout`, then back to the login screen). 403 from any `/api` call (role none) -> an "No access for this account" screen with a Logout button. All text via `textContent`; CSP unchanged; mobile friendly; no flash of the app before auth is known.
- [ ] **Step 1: Failing tests (jsdom):** shows login screen on 401 with a working link; shows login_error messages (and an unknown code shows the generic one, hostile code inert); logged-in state shows name + Logout; Logout calls POST `/auth/logout` and returns to the login screen; 403 shows the no-access screen; the app is not rendered before `/api/me` answers; `index.html` still has no inline script/handlers (existing server test).
- [ ] **Steps 2-5:** run -> FAIL, implement, run all page tests + typecheck -> PASS, commit `feat: login and logout screens in the page`.

### Task 4: Compose, env example and runbook for the Cloudflare-tunnel deployment

**Files:** Create `docker-compose.yml` (repo root), `.env.example`; Modify `deploy/web/README.md`, `deploy/web/compose.snippet.yml` (delete it if the root file replaces it and update the deploy test), `apps/web/tests/deploy.test.ts`, `.dockerignore`/`.gitignore` if needed.

**Content:**
- Root `docker-compose.yml`: service `vast-comfy-web` built from `apps/web/Dockerfile` with context `.`; `env_file: .env`; `ports: ["3400:3000"]` (the tunnel and the LAN reach it like the owner's other apps; document that the app enforces login itself); the hardening already in the snippet (read-only root, tmpfs /tmp, cap_drop ALL, no-new-privileges, healthcheck, limits, stop_grace_period 60s); named volume for the registry (`REGISTRY_PATH=/data/registry.json`); the Tailscale auth key NOT bind-mounted from a host path (the daemon is REMOTE: host paths would resolve on the homelab, not the laptop): use a named volume `vast-comfy-keys` mounted `:ro` at `/run/secrets`, populated once with `docker run --rm -i -v vast-comfy-keys:/k alpine sh -c 'cat > /k/ts-authkey && chmod 640 /k/ts-authkey && chown 0:1000 /k/ts-authkey' < ~/.config/vast-comfy/ts-authkey` (document that exact command with `DOCKER_HOST=tcp://192.168.88.113:2375`); `dns: [100.100.100.100]` is NOT assumed (document the check for tailnet name resolution from the container instead); explain `network_mode` choices only if needed.
- `.env.example`: key NAMES with empty/placeholder values for every required key (VAST_API_KEY, REPO_URL, REPO_COMMIT, PROFILE, AUTHENTIK_ISSUER, AUTHENTIK_CLIENT_ID, AUTHENTIK_CLIENT_SECRET, WEB_PUBLIC_URL=https://gen.3dprintingbandung.my.id, WEB_SESSION_SECRET with the `openssl rand -hex 32` hint, TS_AUTHKEY_FILE=/run/secrets/ts-authkey) plus optional tuning keys commented out; every name must exist in the schema.
- README rewrite (English): architecture (browser -> Cloudflare tunnel -> homelab host :3400 -> container; container -> Authentik public URL for token exchange and JWKS; container -> tailnet instance), deploy from the laptop with `DOCKER_HOST=tcp://192.168.88.113:2375 docker compose up -d --build`, first-time checklist, Authentik setup (Application slug e.g. `vast-gen`; Provider OAuth2/OpenID, confidential; redirect URI `https://gen.3dprintingbandung.my.id/auth/callback`; scopes openid, profile, email with the groups claim present in the token (explain how to verify/add a groups scope mapping); signing key selected so tokens are RS256; bind only the groups `authentik Admins` and `member` to the application; where to read the client id/secret and issuer URL `https://auth.3dprintingbandung.my.id/application/o/<slug>/`), Cloudflare tunnel public hostname `gen.3dprintingbandung.my.id` -> `HTTP 192.168.88.113:3400` (same tunnel as `dashboard.`), smoke checks, rollback, and the "NOT verified yet" list (Authentik groups claim, container-to-tailnet from the homelab host, bare MagicDNS name resolution).
- Tests: every env name in `.env.example`, `docker-compose.yml` and the README exists in the schema; compose has exactly the one published port `3400:3000`, `env_file`, no literal secrets, read-only root, key volume `:ro`; Dockerfile still non-root + HEALTHCHECK. Validate with `docker compose -f docker-compose.yml config` (local engine only; do NOT run `up`, do NOT contact the remote Docker host).
- [ ] Steps: failing deploy tests -> files -> `npx vitest run apps` + `docker compose config` (with a throwaway `.env` copied from `.env.example`, deleted afterwards) -> commit `feat: root compose, env example and runbook for the tunnel deployment`.

## Self-Review

- Spec coverage: OIDC login with a login page (T1-T3), role mapping unchanged (T2), CSRF with cookies (T2), Cloudflare tunnel direct to the container (T4), remote-docker deployment from the laptop (T4).
- Out of scope: the real deployment to the homelab and the first real login (done by the controller with the owner afterwards).

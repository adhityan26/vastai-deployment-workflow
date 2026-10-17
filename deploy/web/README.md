# vast-comfy web: deployment runbook

Service: `apps/web` (Fastify, Node 24). Public URL: `https://gen.3dprintingbandung.my.id`.
Compose file: `docker-compose.yml` at the repository root. Env template: `.env.example`.

## Architecture

    browser -> Cloudflare tunnel -> homelab host 192.168.88.113:3400 -> vast-comfy-web (:3000)
    vast-comfy-web -> https://auth.3dprintingbandung.my.id   (OIDC code exchange + JWKS)
    vast-comfy-web -> Vast REST API                           (rent / destroy)
    vast-comfy-web -> tailnet instance (agent 8189, ComfyUI 18188), through the homelab host

- There is no proxy in front of the app and NPM is not in the path. The Cloudflare Tunnel
  public hostname points straight at the published host port, exactly like `dashboard.`.
  The app enforces login itself, so port 3400 on the LAN is also protected by the login.
- Login: `GET /auth/login` sends the browser to Authentik (authorization code flow with PKCE),
  `GET /auth/callback` exchanges the code server-side with the client secret, verifies the RS256
  ID token and sets a signed, HttpOnly, Secure, SameSite=Lax session cookie. `POST /auth/logout`
  clears it.
- Roles: group `authentik Admins` (start/extend/destroy) and `member` (generate, status). An
  account in neither group is refused at login (`access_denied`). `/api/*` without a session
  answers 401. If any OIDC key or the session secret is empty the service fails closed
  (every `/api/*` is 401, `/auth/login` is 503). `/healthz`, `/auth/*` and the static page are public.
- The browser never talks to the instance; only to `/api/*` of this service.
- The registry (one active instance record) is a JSON file on the named volume `vast-comfy-registry`.
- A new instance joins the tailnet with a single-use auth key read from `TS_AUTHKEY_FILE`.

## Deploying (from the laptop)

The Docker daemon is remote. Run everything from the laptop checkout:

    DOCKER_HOST=tcp://192.168.88.113:2375 docker compose up -d --build

The build context (the repository, minus `.dockerignore` entries) is uploaded to the remote
daemon, and `.env` is read on the laptop, so host paths in the compose file would resolve on
the homelab, not on the laptop; that is why no host path is used.
The image runs the compiled JavaScript as the non-root `node` user.

## First-time checklist (in this order)

- [ ] Authentik application and provider (below); note client id, client secret, issuer.
- [ ] `cp .env.example .env`, fill it in (mode 600, never committed). `WEB_SESSION_SECRET`:
      `openssl rand -hex 32`. `AUTHENTIK_ISSUER` must be copied EXACTLY, including the trailing slash.
- [ ] Tailscale auth key into the `vast-comfy-keys` volume (below), BEFORE the first `up`.
- [ ] Cloudflare tunnel public hostname (below).
- [ ] `DOCKER_HOST=tcp://192.168.88.113:2375 docker compose up -d --build`, then the smoke checks.

## Tailscale auth key

Tailscale admin console -> Settings -> Keys -> Generate auth key: **Reusable off (single-use)**,
**Ephemeral on**, **Pre-approved on**, tag `tag:gpu`, expiry **1 day**. Save it as the only
content of `~/.config/vast-comfy/ts-authkey` on the laptop (mode 600). Then copy it into the
named volume once, from the laptop, against the remote daemon (this also creates the volume):

    DOCKER_HOST=tcp://192.168.88.113:2375 docker run --rm -i -v vast-comfy-keys:/k alpine \
      sh -c 'cat > /k/ts-authkey && chown 0:1000 /k/ts-authkey && chmod 640 /k/ts-authkey' \
      < ~/.config/vast-comfy/ts-authkey

The file is owned by root and group 1000 with mode 640: world-unreadable, readable by gid 1000
(the `node` user of the image). The compose file mounts the volume read-only at `/run/secrets`
and `.env` sets `TS_AUTHKEY_FILE=/run/secrets/ts-authkey`.
The volume is declared `external: true` with `name: vast-comfy-keys`, so the order is: create/fill
the volume first, then `docker compose up`. Compose refuses to start if it is missing. Make a new
key (rerun the command) whenever the previous one was used or expired.

## Authentik setup

Same pattern as the owner's dashboard, but as an OIDC application.

1. Groups: `authentik Admins` (usually exists) and `member`; add users. The names must match
   `WEB_ADMIN_GROUP` / `WEB_MEMBER_GROUP`.
2. Applications -> Create with provider: Application slug e.g. `vast-gen`; Provider type
   OAuth2/OpenID Connect; client type **Confidential**.
3. Redirect URI (strict), exactly: `https://gen.3dprintingbandung.my.id/auth/callback`
4. Scopes: `openid`, `profile`, `email`. The ID token must carry a `groups` claim (array of group
   names). The default "profile" scope mapping includes `groups`; verify under Customization ->
   Property Mappings (and the provider's Preview tab for a user). If it is missing, add a scope
   mapping with expression `return {"groups": [g.name for g in request.user.ak_groups.all()]}`
   and select it on the provider.
5. Signing key: select a certificate-key pair so ID tokens are RS256 (with none selected,
   Authentik signs with HS256 using the client secret and the app refuses those tokens).
6. Policy binding on the application (Policy / Group / User Bindings): bind ONLY the groups
   `authentik Admins` and `member`, so other users cannot log in at all.
7. Copy into `.env`: client id -> `AUTHENTIK_CLIENT_ID`, client secret -> `AUTHENTIK_CLIENT_SECRET`,
   issuer -> `AUTHENTIK_ISSUER`, which is `https://auth.3dprintingbandung.my.id/application/o/<slug>/`
   (keep the trailing slash; it must equal the token `iss` exactly). `WEB_PUBLIC_URL` is the bare
   origin `https://gen.3dprintingbandung.my.id`, no path.

## Cloudflare tunnel

In the SAME tunnel that serves `dashboard.3dprintingbandung.my.id` (Zero Trust -> Networks ->
Tunnels -> Public hostname): add hostname `gen.3dprintingbandung.my.id`, service type `HTTP`,
URL `192.168.88.113:3400`. Optional extra layer: a WAF rate-limit rule on `/api/*`.

## Reaching the instance (UNVERIFIED until the first real boot)

The container reaches tailnet IPs through the host: the host runs tailscaled and Docker's bridge
NAT lets containers use the host's 100.64.0.0/10 routes. The web resolves the instance by its bare
MagicDNS name (`vast-xxxx`), which may NOT resolve inside the container. Check once an instance exists:

    docker exec vast-comfy-web node -e "require('dns').lookup('vast-xxxx',console.log)"

If it fails (UNVERIFIED fallbacks): add `dns: [100.100.100.100]` to the service, or have the
service use the instance 100.x IP. `network_mode: host` is not recommended.

## Smoke checks

1. `docker inspect -f '{{.State.Health.Status}}' vast-comfy-web` becomes `healthy`.
2. `curl -sI https://gen.3dprintingbandung.my.id/api/state` returns 401 with a JSON body, NOT a redirect.
3. The page shows the login button; logging in as an `authentik Admins` user shows the app.
4. A user without a role group (if you temporarily unbind the policy to test) sees `access_denied`.
5. `docker logs vast-comfy-web` shows no secret values and no "FAIL-CLOSED" line.

## Rollback

- Before a rebuild: `docker tag vast-comfy-web:local vast-comfy-web:prev`. To roll back, set
  `image: vast-comfy-web:prev` (remove `build`) and run `docker compose up -d`.
- The registry volume is independent of the image; the service reconciles registry and Vast on
  startup. Always check the Vast console for orphan instances after a rollback.
- Emergency stop: `docker compose stop vast-comfy-web`; destroy any instance in the Vast console.

## Operational notes

- Sessions are stateless: logout clears the browser cookie but cannot revoke a copied cookie
  before it expires (`WEB_SESSION_TTL_H`, default 8 h). Rotating `WEB_SESSION_SECRET` revokes
  everyone. Group changes in Authentik apply at the next login.
- Two tabs starting a login at the same time share one login-transaction cookie; the loser may
  need to retry.
- The callback refuses users without a role group.
- Env keys: see `.env.example`. `COMFY_PORT` and `AGENT_PORT` are fixed (not sent to the
  instance): leave them unset. Not needed by this service: `TS_API_CREDENTIAL`, `DISCORD_BOT_TOKEN`.

## NOT verified yet

- The `groups` claim in a real Authentik ID token (and RS256 signing).
- The Cloudflare tunnel hostname `gen.` -> `192.168.88.113:3400`.
- Container-to-tailnet reachability from the homelab host, and bare MagicDNS names resolving
  inside the container.
- The Vast create/destroy request shapes and the instance label were verified in the T13 spike.
- The image was built and smoke-tested locally only; never run against the real Authentik,
  Cloudflare or Tailscale.

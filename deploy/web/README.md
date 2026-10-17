# vast-comfy web: deployment runbook

Service: `apps/web` (Fastify, Node 24). Public URL: `https://gen.3dprintingbandung.my.id`.

## Architecture

1. Browser -> Cloudflare (proxied DNS or Cloudflare Tunnel) for `gen.3dprintingbandung.my.id`.
2. Cloudflare -> the Authentik proxy outpost on the homelab. Never directly to the web container.
3. The outpost authenticates the user, then forwards the request to `vast-comfy-web:3000`
   on a shared Docker network, adding the signed identity token as the `X-authentik-jwt` header.
4. The web service verifies that JWT itself (JWKS, issuer, audience) and maps the groups
   `authentik Admins` (start/extend/destroy) and `member` (generate, status) to roles.
   If the Authentik keys are empty, it fails closed (every request is 401).
5. The web service talks to the Vast REST API (rent/destroy) and, over the tailnet, to the
   instance (agent port 8189, ComfyUI port 18188, both `tag:gpu`).
6. The registry (one active instance record) is a JSON file on a named Docker volume.
7. The homelab host (tailnet node `docker-apps`) runs `tailscaled`; the container reaches the
   instance through the host's network path.
8. A new instance joins the tailnet with a single-use auth key read from `TS_AUTHKEY_FILE`.
9. The browser never talks to the instance; only to `/api/*` of this service.
10. No host port is published.

## Build context

The image is built with the repository root as the build context:

    docker build -f apps/web/Dockerfile -t vast-comfy-web:local .

The compose snippet (`compose.snippet.yml`) does this with `context: ../..`. The image runs the
compiled JavaScript (`node apps/web/dist/main.js`) as the non-root `node` user and ships only
`dist`, the built page, `contracts/{config-schema.yaml,instance-registry.schema.json,status.schema.json}`,
`instance/profiles` and `instance/workflows`.

## First-time setup checklist

- [ ] Create the Authentik objects (below) and note the three values for the `.env`.
- [ ] Create the Cloudflare route (below).
- [ ] Create the Tailscale auth key file (below).
- [ ] Write `.env` next to the compose file on the homelab (mode 600, never committed).
- [ ] Merge `compose.snippet.yml`; replace the `ts-authkey` host path and, if needed, the
      `authentik_proxy` network name.
- [ ] `docker compose up -d --build vast-comfy-web`, then run the smoke checks.

## `.env` key names (names only; every key exists in `contracts/config-schema.yaml`)

Required:

- `VAST_API_KEY`
- `REPO_URL`
- `REPO_COMMIT`
- `PROFILE`
- `AUTHENTIK_JWKS_URL`
- `AUTHENTIK_ISSUER`
- `AUTHENTIK_AUDIENCE`

(The three `AUTHENTIK_*` keys have empty defaults, but with empty values the service fails
closed, so they are required in practice. `TS_AUTHKEY_FILE` and `REGISTRY_PATH` are set in the
compose snippet.)

Optional (defaults are in the schema):

- `WEB_ADMIN_GROUP`, `WEB_MEMBER_GROUP`, `WEB_PORT`, `WEB_HOST`, `WEB_REPO_DIR`
- `REGISTRY_PATH`, `TS_AUTHKEY_FILE`
- `VAST_API_URL`, `VAST_IMAGE`, `VAST_DISK_GB`, `VAST_MIN_VRAM_GB`, `VAST_MAX_DPH`,
  `VAST_MIN_DOWNLOAD_MBPS`, `VAST_MIN_RELIABILITY`, `VAST_ALLOWED_GPUS`
- `START_IDLE_MINUTES`, `START_FAILSAFE_HOURS`, `START_HARD_CAP_HOURS`, `START_RATE_LIMIT_PER_HOUR`
- `COMFY_PORT`, `AGENT_PORT`, `STATUS_POLL_S`, `RECONCILE_INTERVAL_S`, `RECONCILE_GRACE_MIN`
- `GENERATE_MAX_PROMPT_CHARS`, `GENERATE_TIMEOUT_S`, `WEB_GENERATE_RATE_LIMIT_PER_HOUR`
- `HTTP_TIMEOUT_S_APPS`, `WEB_DESTROY_RETRIES`, `WEB_DESTROY_BACKOFF_S`, `WEB_SHUTDOWN_WAIT_S`
- `WEB_BODY_LIMIT_BYTES`, `WEB_JOB_CACHE_MAX`, `WEB_JOB_TTL_S`, `WEB_EXTEND_MAX_MINUTES`,
  `WEB_IMAGE_MAX_BYTES`, `WEB_JSON_MAX_BYTES`
- `WEB_REQUEST_TIMEOUT_S`, `WEB_CONNECTION_TIMEOUT_S`, `WEB_KEEPALIVE_TIMEOUT_S`

Not needed by this service: `TS_API_CREDENTIAL`, `DISCORD_*`.

## Authentik setup

1. Create **groups** `authentik Admins` (usually exists) and `member`, and add users. The names
   must match `WEB_ADMIN_GROUP` / `WEB_MEMBER_GROUP`. A user in neither group gets 403.
2. Create an **application** (e.g. slug `vast-comfy-web`) with a **Proxy Provider** in
   **forward auth (single application)** mode, or the reverse-proxy mode of the outpost, with
   external host `https://gen.3dprintingbandung.my.id` and internal host
   `http://vast-comfy-web:3000`. Assign the provider to the (embedded or dedicated) outpost.
3. The outpost must forward the signed JWT to the backend as the `X-authentik-jwt` header (the
   proxy provider does this and carries the user's groups in the `groups` claim). Verify with
   a request and check the header reaches the service (a 200 on `/api/state` after login).
4. Fill in the values (find them in Authentik):
   - `AUTHENTIK_JWKS_URL`: Providers -> your provider -> the "JWKS URL" shown in the provider
     overview (form `https://<authentik-host>/application/o/<slug>/jwks/`).
   - `AUTHENTIK_ISSUER`: the "OpenID Configuration Issuer" on the same page
     (`https://<authentik-host>/application/o/<slug>/`); it must match the token's `iss` exactly.
   - `AUTHENTIK_AUDIENCE`: the provider's Client ID (the token `aud`).
   Open the provider's OpenID Configuration URL to copy these exactly.
5. Restrict the application with a policy binding to the two groups.

## Cloudflare setup (`gen.3dprintingbandung.my.id`)

- Use a Cloudflare Tunnel (public hostname `gen.3dprintingbandung.my.id` -> the Authentik proxy
  outpost service/URL), or a proxied (orange cloud) DNS record to the homelab entrypoint that
  serves the outpost. The origin is always the outpost, never `vast-comfy-web`.
- Optional extra layer: a Cloudflare WAF rate-limiting rule on `/api/*` and/or Cloudflare
  Access in front of the hostname. The app already rate-limits Start and Generate.
- Set SSL/TLS mode to Full (strict) if the origin speaks HTTPS.

## Tailscale

- The existing policy lets `autogroup:member` reach `tag:gpu` on ports 18188 and 8189. The
  homelab node `docker-apps` is a member device, so no ACL change is needed.
- First boot auth key (manual): Tailscale admin console -> Settings -> Keys -> Generate auth
  key with **Reusable off (single-use)**, **Ephemeral on**, **Pre-approved on**, tag
  `tag:gpu`, expiry **1 day**. Save the key as the only content of the host file referenced in
  the compose volume, then `chmod 600` it (and `chown 1000` so the container user can read it).
  Make a new key whenever the previous one was used or expired.

### Reaching the instance (UNVERIFIED without the real homelab)

The container must reach tailnet IPs (100.64.0.0/10) and, if the registry stores a MagicDNS
name, resolve it. Recommended simplest option: keep the container on the bridge network shared
with the outpost and let traffic leave via the host, which runs `tailscaled`. Docker NATs the
container's traffic through the host, and the host routes 100.64.0.0/10 to `tailscale0`.
For names, either rely on the host resolver (if it uses MagicDNS 100.100.100.100) or set
`dns: [100.100.100.100]` in the compose snippet. Trade-off: this keeps the container isolated,
the web port unpublished and the outpost network intact. The alternative `network_mode: host`
removes all of the NAT/DNS questions but cannot join the outpost network (the outpost would have
to reach the service on the host) and exposes the port on the host, so it is not recommended.
Check with: `docker exec vast-comfy-web node -e "fetch('http://<tailnet-ip>:18188').catch(e=>console.log(e.cause?.code))"`
against any running tailnet device with that port open.

## Smoke checks after first start

1. `docker inspect -f '{{.State.Health.Status}}' vast-comfy-web` becomes `healthy`.
2. From another container on the shared network: `GET http://vast-comfy-web:3000/healthz` -> 200
   (no auth needed).
3. `GET /api/state` without identity -> 401 (also what you get if the Authentik keys are empty).
4. Open `https://gen.3dprintingbandung.my.id`, sign in: the state page shows "no instance".
   A `member` user cannot Start (403); an `authentik Admins` user can.
5. Logs (`docker logs vast-comfy-web`) show no secret values and no "auth is FAIL-CLOSED" line.

## Rollback

- Keep the previous image tagged (`docker tag vast-comfy-web:local vast-comfy-web:prev` before a
  rebuild). Roll back with `image: vast-comfy-web:prev` (remove `build`) and
  `docker compose up -d vast-comfy-web`.
- The registry volume is independent of the image. If an instance is running, a restart is safe:
  the service reconciles registry and Vast on startup. Always check the Vast console for
  orphan instances after a rollback.
- Emergency stop: `docker compose stop vast-comfy-web`; destroy any instance in the Vast console.

## What is NOT verified yet

- The Vast create/destroy REST request and response shapes, and the instance label
  `vastcomfy:<hostname>` (contains a colon) are UNVERIFIED until the first real boot (Task 12).
- The container-to-tailnet path and DNS (section "Reaching the instance") and the exact
  Authentik outpost header and claim behaviour need to be checked on the real homelab.
- The image was built and smoke-tested locally only (healthz 200, `/api/state` 401, read-only
  rootfs); it was never run against the real Vast, Authentik, Cloudflare or Tailscale.

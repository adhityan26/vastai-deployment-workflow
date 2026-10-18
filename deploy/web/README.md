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
- A new instance joins the tailnet with a single-use auth key: minted per Start through the
  Tailscale OAuth client (`TS_OAUTH_CLIENT_ID` + `TS_OAUTH_CLIENT_SECRET`, preferred), or, only
  when neither OAuth key is set, read from `TS_AUTHKEY_FILE`.

## Deploying (from the laptop)

The Docker daemon is remote. First, in the shell you deploy from, point the Docker client at it:

    export DOCKER_HOST=tcp://192.168.88.113:2375

**Every `docker` command in this runbook assumes that export** (`docker inspect`, `docker exec`,
`docker logs`, `docker tag`, `docker compose ...`). Without it they talk to the laptop's LOCAL
daemon and silently inspect, tag or stop nothing. Run `unset DOCKER_HOST` when you are done. The
commands that must never run against the wrong daemon (the key-volume fill, `up`, the emergency
stop) also carry an explicit `DOCKER_HOST=...` prefix, so copy-pasting them is safe on their own.

Use the `docker compose` plugin (Compose v2 or newer); legacy v1 `docker-compose` is not supported
(it ignores the `deploy.*` limits). `tcp://192.168.88.113:2375` is an unauthenticated, unencrypted
Docker API: acceptable only on a trusted LAN. That includes the secrets: the `.env` values
(`AUTHENTIK_CLIENT_SECRET`, `WEB_SESSION_SECRET`, `VAST_API_KEY`) travel to the daemon in clear
text over port 2375, and anyone on the LAN who can reach that port can read them back with
`docker inspect vast-comfy-web`. Same trusted-LAN caveat; do not expose port 2375 anywhere else.
Run everything from the laptop checkout:

    DOCKER_HOST=tcp://192.168.88.113:2375 docker compose up -d --build

The build context (the repository, minus `.dockerignore` entries) is uploaded to the remote
daemon, and `.env` is read on the laptop, so host paths in the compose file would resolve on
the homelab, not on the laptop; that is why no host path is used.
The image runs the compiled JavaScript as the non-root `node` user.

## First-time checklist (in this order)

- [ ] Authentik application and provider (below); note client id, client secret, issuer.
- [ ] `cp .env.example .env`, fill it in (mode 600, never committed). `WEB_SESSION_SECRET`:
      `openssl rand -hex 32`. `AUTHENTIK_ISSUER` must be copied EXACTLY, including the trailing slash.
      Keep `WEB_OIDC_SKEW_S=5` from the template: Authentik may run on another clock, and with a skew
      of 0 an ID token whose `iat` is even 1 s in the future (by our clock) is rejected.
- [ ] Tailscale OAuth client (below) into `.env`; or, without it, the Tailscale auth key into the
      `vast-comfy-keys` volume (below). The volume must exist BEFORE the first `up` either way.
- [ ] Cloudflare tunnel public hostname (below).
- [ ] `DOCKER_HOST=tcp://192.168.88.113:2375 docker compose up -d --build`, then the smoke checks.

## Tailscale OAuth client

Preferred over the key file: the service mints a fresh key for every Start, so there is no key to
renew or to run out of.

1. Tailscale admin console -> Settings -> OAuth clients -> Generate OAuth client.
2. Scopes: **Keys -> Auth Keys: Write** and nothing else. Tags: `tag:gpu` (the tag must exist in
   the tailnet policy `tagOwners`; it must match `TS_OAUTH_TAG`, default `tag:gpu`).
3. Copy the client id and the client secret (shown once) straight into `.env` on the laptop as
   `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_CLIENT_SECRET`. Never paste them into a chat, an issue or
   a commit. Set both or neither: with exactly one set the service logs
   `tailscale auth key source: misconfigured` at startup and refuses every Start with reason
   `ts_key_mint_failed` (it never falls back to the key file).
4. Recreate the container (`DOCKER_HOST=tcp://192.168.88.113:2375 docker compose up -d`). The
   startup log says `tailscale auth key source: oauth`.

Each minted key is single-use, ephemeral, pre-approved, carries only `TS_OAUTH_TAG` and expires
after `TS_KEY_TTL_S` seconds (default 3600; if Tailscale refuses that value the service retries
once with 86400 and logs `tailscale key ttl fallback`). The secret, the access token and the
minted keys stay in memory only; none is written to the registry, a log line or a response.

Verify: with no file in the key volume (or `TS_AUTHKEY_FILE` pointing nowhere), Start works and the
new node shows up in the admin console as ephemeral with tag `tag:gpu`. A failure shows as
`start failed: StartError (internal: ts_key_mint_failed)` in the log, and the cause as
`tailscale token request failed: ...` or `tailscale key request failed: ...` (a fixed code plus
the HTTP status, never the provider's text).

Revoking the OAuth client in the admin console stops all key minting at once (Start then fails
with `ts_key_mint_failed`); keys already handed to running instances are single-use and expire on
their own.

## Tailscale auth key (fallback without OAuth)

Used only when `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_CLIENT_SECRET` are both empty (startup log:
`tailscale auth key source: file`).

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
   names). The provider setting **"Include claims in id_token" must stay ON** (the default): the app
   reads the groups only from the ID token, so with it off `groups` is empty and every user gets
   `access_denied`. The default "profile" scope mapping includes `groups`; verify under Customization ->
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

Log in through the public hostname `https://gen.3dprintingbandung.my.id` only. Logging in through
the LAN address `http://192.168.88.113:3400` cannot work: the cookies are `Secure` with the
`__Host-` prefix, and the redirect URI and the Origin check are bound to the public hostname.
(With `export DOCKER_HOST=...` set, see "Deploying".)

1. `docker inspect -f '{{.State.Health.Status}}' vast-comfy-web` becomes `healthy`.
2. `docker inspect -f '{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}}' vast-comfy-web` prints
   `128 268435456` (the pids and memory limits are applied).
3. `curl -s -o /dev/null -w '%{http_code}\n' https://gen.3dprintingbandung.my.id/api/state` prints
   `401` (a GET without a session; NOT a redirect). Cloudflare bot protection may challenge curl
   (403 or a challenge page); then check the same request from the browser devtools network tab.
4. The page shows the login button; logging in as an `authentik Admins` user shows the app.
5. A user in neither role group is stopped by Authentik's own denial page and never reaches the app,
   because only the two groups are bound. The app's `access_denied` path is reachable only if the
   policy binding is removed, which opens login to EVERY Authentik user: do that only briefly, or
   test with a user in a third group that is bound to the application.
6. `docker logs vast-comfy-web` shows no secret values and no "FAIL-CLOSED" line.

## Rollback

- Before a rebuild: `docker tag vast-comfy-web:local vast-comfy-web:prev`. To roll back, set
  `image: vast-comfy-web:prev` (remove `build`) and run `docker compose up -d`.
- The registry volume is independent of the image; the service reconciles registry and Vast on
  startup. Always check the Vast console for orphan instances after a rollback.
- Emergency stop (explicit prefix; without it this stops nothing):
  `DOCKER_HOST=tcp://192.168.88.113:2375 docker compose stop vast-comfy-web`; then destroy any
  instance in the Vast console.

## Troubleshooting login

`docker logs vast-comfy-web` shows one line per failed login, `login failed: <code>`, plus the
internal reason when it says more, e.g. `login failed: provider_error (internal: discovery_failed)`.
The browser only ever sees the coarse code (`/?login_error=<code>`).

- `discovery_failed`: the app could not load `<AUTHENTIK_ISSUER>.well-known/openid-configuration`
  or the issuer in it differs. Most often `AUTHENTIK_ISSUER` lacks Authentik's trailing slash
  (`.../application/o/<slug>/`), or the container cannot reach the Authentik public URL.
- `token_invalid`: the ID token failed verification (wrong signing key type, e.g. HS256 because no
  certificate is selected; wrong client id; or clock skew, see `WEB_OIDC_SKEW_S`).
- `access_denied (internal: no_role_group)`: the account has neither role group in its ID token
  (check "Include claims in id_token" and the groups mapping).
- `state_mismatch (internal: no_valid_transaction_cookie)`: the login took longer than 10 minutes,
  was started on another hostname (e.g. the LAN address), or another tab restarted it.

## Operational notes

- Sessions are stateless: logout clears the browser cookie but cannot revoke a copied cookie
  before it expires (`WEB_SESSION_TTL_H`, default 8 h). Rotating `WEB_SESSION_SECRET` revokes
  everyone. Group changes in Authentik apply at the next login.
- Two tabs starting a login at the same time share one login-transaction cookie; the loser may
  need to retry.
- The callback refuses users without a role group.
- Env keys: see `.env.example`. `COMFY_PORT` and `AGENT_PORT` are fixed (not sent to the
  instance): leave them unset. Not needed by this service: `TS_API_CREDENTIAL` (superseded by the two
  `TS_OAUTH_CLIENT_*` keys), `DISCORD_BOT_TOKEN`.

## Boot console

Admins see a live console of the instance boot (`GET /api/console`; members get 403). It merges
Vast's `status_msg` (docker pull progress while the instance is `loading`), the container log
(PID 1 stdout, read through Vast's log-request API and a pre-signed https file fetched without the
API key) and a one-line summary of the agent's `/status`. Every line is masked before it is stored
or sent (known secrets, `tskey-*`, Bearer and Authorization values, `*key`/`token`/`secret`/`password`
values, long hex/base64 strings, URL credentials); the instance hostname shows as `[host]`.

- Bounds: `BOOT_LOG_MAX_LINES` lines of at most `BOOT_LOG_MAX_LINE_CHARS` characters; a log download
  stops at `BOOT_LOG_MAX_BYTES`; `BOOT_LOG_TAIL_LINES` lines are requested per read.
- Cost: Vast is read for the console at most once per `BOOT_LOG_POLL_MIN_S`, and only while an admin
  has called the console within `BOOT_LOG_WATCH_S`; an idle page costs nothing.
- The lines survive a restart in `BOOT_LOG_PATH`; compose puts it on the data volume next to
  `REGISTRY_PATH` (`/data/boot-console.json`). A corrupt file is ignored (the console starts empty).
- After an instance ends its last lines stay visible (with the reason) until the next Start.
- The phases come only from the instance's marker lines `[boot] step <n>/<m>: <id>` and
  `[boot] FAILED: <code>` (the fixed step list is defined once in `apps/core/src/console.ts`).

## Usage history

Admins see a "History" card (`GET /api/history`; members get 403): one line per instance session with
the start time, duration, GPU, an estimated cost (duration x price per hour; disk and traffic are
billed separately) and why it stopped: the Destroy button (with who pressed it), the idle timeout,
the failsafe deadline, the hard cap, a failed boot or Start, an unreachable agent, or "disappeared"
when the cause is unknown (e.g. Vast removed it).

- When the web service stops the instance itself it records why before it acts. When the instance
  stops itself, the reason comes from the last agent `/status` the web saw: the agent's own destroy
  state and reason first, then the earliest idle, failsafe or hard-cap deadline that had passed by
  the time the web noticed (plus `USAGE_REASON_SLACK_S` for clock skew), else "disappeared".
  The first recorded reason wins, so in two rare cases the label can be wrong: Destroy pressed while
  the create was still uncertain followed by a web restart (the boot timeout then destroys it, the
  history says Destroy button), and a Start whose registry write and cleanup destroy both failed (a
  later stop still shows "Boot failed").
- The instance prints `[watchdog] destroying instance: reason=<reason>` before each self-destroy
  (agent log under supervisor, `failsafe.log` for the standalone failsafe).
- Times: a stop by the web is dated when it completed; a self-stop at the passed deadline, or else at
  the last time the web saw the agent. Agent sightings are written to the file when something the
  reason depends on changes (state, reason, the order of the deadlines, a deadline moving earlier or
  later by more than the slack) and otherwise about once per `USAGE_REASON_SLACK_S`. After a web
  restart, until the agent is seen again, the saved copy is used: its deadlines may be up to the slack
  early, so they are compared without the slack (a deadline then counts only when it lies before the
  moment the web noticed the end), and its last sighting may be up to about the slack old.
- `USAGE_LOG_MAX_ENTRIES` (at least 2) sessions are kept in `USAGE_LOG_PATH` (compose: `/data/usage-history.json`,
  next to the registry); a corrupt file is ignored. The web log gets one `usage: start ...` and one
  `usage: stop ...` line per session (GPU, price, reason, duration and user names only).

## Image edit with reference images

Members can switch the Generate card to "Edit images", attach up to `EDIT_MAX_REFERENCES` PNG/JPEG/WebP
files and describe the change. The files travel as base64 in the JSON body of `POST /api/edit`, are
validated on the server (magic bytes, `EDIT_REFERENCE_MAX_BYTES`, `EDIT_REFERENCE_MAX_PIXELS`,
`EDIT_REFERENCE_MAX_SIDE`, `EDIT_REFERENCE_TYPES`; animated PNG/WebP and multi-frame JPEG/MPO files are
refused because ComfyUI would decode every frame), uploaded to the instance's ComfyUI under random names and are not stored by the
web service. The route has its own request body limit derived from those values, so
`WEB_BODY_LIMIT_BYTES` can stay small. A reverse proxy or the Cloudflare tunnel must allow a request body
of that size (about `EDIT_MAX_REFERENCES` x `EDIT_REFERENCE_MAX_BYTES` x 1.34, about 45 MB with the defaults;
see the note on Cloudflare below). The profile's `edit` section turns the feature on; without it the
page shows only Generate.

Limits to keep in mind:

- Upload bandwidth: a full request (4 x 8 MiB with the defaults, about 45 MB as base64) must arrive
  within `WEB_REQUEST_TIMEOUT_S` (default 30 s), which needs roughly 12 Mbit/s of upload from the
  browser. Raise the timeout or lower `EDIT_REFERENCE_MAX_BYTES` for slower links.
- The Cloudflare request body limit has not been verified against a real edit request yet; test a
  4-reference request through the tunnel before relying on the defaults.
- Reference images stay in ComfyUI's `input/` directory on the instance until the instance is
  destroyed; the web service does not delete them after the job.

## Vast credit (admin)

Admins see the prepaid Vast credit in the status card. The page asks `GET /api/credit` about once a
minute; the server reuses one read for `VAST_CREDIT_CACHE_S` (default 60) and shares a read in flight, so any
number of tabs cost at most one Vast call per interval. The call is `GET users/current` with the main
API key (the same `VAST_API_KEY`); only the `credit` number is passed on, never the account record
(which holds the email and ssh keys). Members never see or request it. "unavailable" means Vast could not
be read; it does not affect anything else on the page.

## Gallery in MinIO (Save and the gallery)

Members can save a result image (a **Save to gallery** button per image, or the "save automatically" box on
this device) and open a gallery of what they saved, from any device. Admins can also list everyone's images.
The bucket is private: the browser only talks to this service, which fetches the image from the instance,
checks that it is a PNG/JPEG/WebP and stores it. Plan: `docs/superpowers/plans/2026-10-18-gallery-minio.md`.

1. **Bucket, no public access.** With the MinIO client (`mc`, alias `local`):
   `mc mb local/vast-gallery` and `mc anonymous set none local/vast-gallery`.
2. **A user that can only use that bucket.** Save this as `vast-gallery-rw.json` (change the bucket name if you
   changed `GALLERY_S3_BUCKET`):
   ```json
   {"Version":"2012-10-17","Statement":[
     {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":["arn:aws:s3:::vast-gallery"]},
     {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::vast-gallery/*"]}]}
   ```
   then `mc admin policy create local vast-gallery-rw vast-gallery-rw.json`,
   `mc admin user add local <ACCESS_KEY> <SECRET_KEY>` and
   `mc admin policy attach local vast-gallery-rw --user <ACCESS_KEY>` (older `mc` spells these `policy add`
   and `policy set`). Do not reuse the MinIO root credentials.
3. **`.env`:** `GALLERY_S3_ENDPOINT` (the MinIO API URL as the container reaches it, for example the LAN
   address and port 9000; plain http is fine on the LAN, never publish MinIO through the tunnel for this),
   `GALLERY_S3_ACCESS_KEY` and `GALLERY_S3_SECRET_KEY` (both are secrets: they are redacted from every
   response). An empty endpoint switches the feature off and the page shows no Save button or gallery card.
4. **Redeploy, then check:** save one image, then `mc ls --recursive local/vast-gallery` shows
   `u/<32 hex>/<time>-<job>-<index>`. The 32 hex characters are a hash of the member's login subject.

- **Limits per member** (the server refuses a Save above them with `gallery_quota`):
  `GALLERY_MAX_IMAGES_PER_USER` (300) and `GALLERY_MAX_BYTES_PER_USER` (2 GiB). The same job image saved
  twice is one object. `GALLERY_PAGE_SIZE` images per page. An admin's "everyone" view merges the members' folders newest
  first and reads at most `GALLERY_ADMIN_SCAN_MAX` keys per page: each member costs `GALLERY_PAGE_SIZE` + 2,
  so with the defaults (5000, 12) up to 357 members are shown completely; members beyond that bound (in
  folder order, a hash of the login) are left out of the view, never the oldest images of one member.
- **What is stored:** the image with its own content type, plus prompt, settings label, owner name and kind
  as (URL-encoded, trimmed) object metadata. There is no database; deleting in the page deletes the object.
  An admin may save any member's finished job (admins can read every job): the image, with that member's
  prompt and settings, then lands in the admin's own gallery, under the admin's name.
- **Abuse limits:** `GALLERY_SAVE_RATE_LIMIT_PER_HOUR` (120) saves per member per hour (`rate_limited`).
  One member's saves run one after the other (the quota check and the write cannot interleave), so a burst
  of saves never passes the quota; this holds for one web process, which is the only writer of the bucket.
- **Memory:** at most `GALLERY_MAX_CONCURRENT` (3) saves and image reads run at once (the others wait), and
  each holds one copy of an image of at most `WEB_IMAGE_MAX_BYTES`: a body with a Content-Length is read
  straight into one buffer, and every read stops as soon as it passes the cap (Content-Length or not). The
  object-store deadline (`WEB_IMAGE_TIMEOUT_S`) covers the body as well as the request. Compose limits the
  container to 256M; with the 32 MiB default cap, 3 slots stay below 100M. Raising the cap or the slots
  needs a matching `memory` in `docker-compose.yml` (and its assertion in `apps/web/tests/deploy.test.ts`).
- **No thumbnails yet:** the gallery loads the stored images themselves, lazily and a page at a time.

## Already verified

The Vast create/destroy request shapes and the instance label were verified in the T13 spike.

## NOT verified yet

- Saving to and listing from a real MinIO: only a fake S3 server and an in-memory store were used. The
  first real Save is the check (path-style addressing, the checksum settings and the bucket-only policy).

- `GET /api/v0/users/current` against the live API: the path and the `credit` field come from the vastai
  1.8.3 SDK source and from the T13 spike, which watched `credit` fall by the cost of a boot.

- Edit with reference images through the real stack (upload over the tailnet, two references, the
  Cloudflare body size); the workflow itself was verified in spike S6.

- Tailscale OAuth key minting against the real API: the token and key request shapes follow
  the public API docs; the smallest accepted `TS_KEY_TTL_S` and the scope/tag acceptance are unmeasured.
- The `groups` claim in a real Authentik ID token (and RS256 signing).
- The Cloudflare tunnel hostname `gen.` -> `192.168.88.113:3400`.
- Container-to-tailnet reachability from the homelab host, and bare MagicDNS names resolving
  inside the container.
- The image was built and smoke-tested locally only; never run against the real Authentik,
  Cloudflare or Tailscale.

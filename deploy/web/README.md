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
- Stuck start: sometimes Vast pulls the image but the host never starts the container (the
  instance stays `created` with intended/current state `stopped` and no `last_started`, while
  storage is billed). The reconcile loop releases a booting instance whose agent does not answer
  when that state held on two consecutive successful reconciles at least a minute apart and the
  instance is older than `VAST_START_STUCK_MIN` (default 5; must be below `BOOT_TIMEOUT_MIN`).
  One Vast sample is never enough, and any other sample (loading, running, an answering agent)
  starts the count over; after a web restart the count starts over too (that only delays it).
  Not stuck, so only `BOOT_TIMEOUT_MIN` (25) applies: an image still loading and `created` with a
  running intent (the normal moment before the start). A running container whose agent is not up
  yet is not stuck either; it meets the slow-boot rule below ("Slow boots").
  - Never started (`start_stuck`): usage reason "Boot failed", console "the rented machine did not
    start", a `lifecycle: start stuck` warning with the instance and machine ids, and the page says
    "The rented machine did not start. It was released; try Start again." The next Starts,
    estimates and the GPU list skip that machine for `VAST_BAD_MACHINE_TTL_MIN` (default 60).
  - Started, then exited/stopped during the boot (`boot_stopped`): released the same way, but the
    page says "The rented machine stopped while it was starting" and the machine is not avoided
    (the cause may be the boot itself).
  - It never retries by itself. The stuck starts (and each session's server location) are kept in
    the usage file (`USAGE_LOG_PATH`) under the top-level keys `stuck` and `servers`, never in the
    registry: an older web ignores those keys, so rolling back needs no file edits.
- Where the server is: the status card shows "Server: Quebec, CA, 860 Mbps down" (Vast's
  `geolocation` and `inet_down` of the instance, else of the offer chosen at Start; missing parts
  are left out), the start dialog shows it for each GPU and in the estimate, the stuck-start
  message names it, and each usage history session keeps it. Members get location and speeds;
  admins also get the Vast machine id; host ids and addresses are never sent. The location is
  Vast's free text reduced to letters, digits, spaces and `,.'()-` (at most 64 characters).
- Download speed dominates the boot: the profile downloads about 15 GB of models. 15 GB is
  120 Gbit, so at 200 Mbps it takes about 600 s (10 min), at 500 Mbps about 4 min and at 860 Mbps
  under 2.5 min (plus the image pull). `VAST_MIN_DOWNLOAD_MBPS` (default 500) is sent in the offer
  search and re-checked locally: an offer that reports a slower `inet_down` is never listed or
  rented (one that reports no speed is kept, as Vast already filtered it).

## Slow boots

What happened on 2026-10-19 (two paid boots lost):

- Instance 56685310, RTX A5000 in Lithuania, Vast-reported `inet_down` 888 Mbps: the models came from
  Hugging Face at about 2.8 MB/s (curl on the instance: one stream 2.8 MB/s), so the 15 GB would have
  taken about 1.5 h. The instance gave up by itself after 676 s (`boot_failed`).
- Instance 56702981, RTX 3090 in California, 800 Mbps: after 20+ minutes the bootstrap was still in
  `install_tools` and the models folder held 1 MB; the web destroyed it only at `BOOT_TIMEOUT_MIN` (1525 s).
- A healthy boot (Quebec 3090, about 55 MB/s) takes about 7 minutes, the model download about 5 of them.

Vast's `inet_down` (and `VAST_MIN_DOWNLOAD_MBPS`) is a property of the machine's uplink as Vast measured
it, not of the route to Hugging Face, its CDN or the apt/PyPI mirrors: both machines above passed the
500 Mbps filter. So the guards below measure what the boot itself sees, and a machine they give up on for
its own fault is put on the bad-machine list (`VAST_BAD_MACHINE_TTL_MIN`, default 60, the same list the stuck start
uses, kept in the usage file) so the next Start rents a different one. Only the machine id is kept, not
the region.

1. **Network probe on the instance (first boot step, `net_probe`).** Before anything is installed,
   `instance/bootstrap.sh` reads the first `NET_PROBE_BYTES` (default 48 MiB) of the profile's largest
   pinned model (the text encoder of the shipped profile: the same repo and Hugging Face storage path
   as most of the 15 GB; the URL comes from the profile, never from code) in two halves over one
   connection (`curl --next`) and times only the second half, first body byte to end. The first half
   pays for TCP slow start, TLS and the redirect: on a 120 ms round trip a healthy 55 MB/s link reads
   only about 20 MB/s over its first 24 MiB. Below `NET_PROBE_MIN_MBPS` (default 6 MB/s, more than
   twice the 2.8 MB/s of the Lithuania boot) it waits 5 s and measures once more (a transient dip, or
   the image entrypoint competing for the link); still slow, it prints `[boot] net_probe: measured <N>
   MB/s (minimum <M> MB/s)` and `[boot] FAILED: slow_network` to the container log and destroys itself
   with the image's stock vastai CLI (the emergency path, exit code 14). That is a few paid seconds
   instead of a 25 minute wait. A sample cut by curl's time cap counts only with at least 4 MiB or 2 s
   of body. It never probes on a container restart (the first-boot time file exists) or when every
   pinned model is already on disk, so a restarted or ready instance is never destroyed by it. A probe
   that cannot run (no curl, no usable profile entry, an HTTP error, too little data, a bad key value)
   only logs a warning and the boot goes on; it never destroys on its own malfunction. It sends no
   token (the pinned files are public). `NET_PROBE_MIN_MBPS=0` turns it off. The web passes both keys
   to the instance (they are read before the instance config exists, with the schema defaults). The
   threshold is deliberately low: a single stream undercounts what the parallel downloader gets, and
   the web's download rule below catches the middle band.
2. **Agent silent (web, `slow_boot`).** Vast says the container runs, but the agent has never answered
   (counted from the first reconcile that saw it running, so a long unbilled image pull does not count)
   for `BOOT_AGENT_GRACE_MIN` (default 10; at least 2 and below `BOOT_TIMEOUT_MIN`). A healthy agent
   answers 2-3 minutes after the start. This is the California case (stuck installing tools).
3. **Slow download (web, `slow_download`).** While the agent reports the model download, the web
   averages the overall bytes (across the profile files) since the first sample of a window; once the
   window is `MODEL_ETA_MIN_OBSERVE_S` (default 120) long, a remaining time above
   `BOOT_MAX_DOWNLOAD_ETA_MIN` (default 20) at that speed is slow. For 15 GB that is below about
   12.5 MB/s at the start; 55 MB/s gives an ETA of about 5 min, 2.8 MB/s about 90 min. Also slow: a
   download that at that speed would end (plus 2 min for the rest of the boot) after
   `BOOT_TIMEOUT_MIN`. Without it a band of about 12.5-15 MB/s (or a late start) was doomed: under the
   ETA limit, yet the boot timeout released it later without blaming the machine. A healthy 18-20 MB/s
   download that starts on time is not released. The agent's status carries bytes only, so the web
   computes the rate itself (the page does the same for its own speed and ETA). Fewer bytes than at
   the previous sample (a retry restarted a file) start a new window.
4. **A boot that vanished (web, `boot_failed`).** An instance that disappears while it is still
   booting (it never reached ready) and that the web did not stop (no Destroy button, no web release,
   no recorded stop) gave up by itself. The page says so; whether its machine goes on the list depends
   on why, from the boot console's `[boot] FAILED: <code>` (only read while an admin watched it) and the
   reason of the last failing agent status the web saw. Where the web cannot tell it is the machine, it
   does not blame it:

   | Failure code(s) seen                                                   | Machine avoided |
   |------------------------------------------------------------------------|-----------------|
   | `slow_network` (the probe; the page then shows `slow_download` with its speed) | yes     |
   | `disk_insufficient`                                                    | yes             |
   | none at all (it vanished without a word, e.g. the host died)           | yes             |
   | `tailscale_failed`, auth key problems                                  | no (service-wide) |
   | `download_failed` (mostly Hugging Face 401/403/5xx)                    | no (service-wide) |
   | git clone, `node_install_failed`, `node_import_failed`, `comfyui_start_failed`, `config_invalid`, `agent_start_failed`, `supervisor_failed`, `failsafe_failed` | no (a code or setup problem) |
   | the generic `boot_failed`, or any other code                           | no (cannot tell) |

   The machine id comes from the last Vast row or the chosen offer in memory, so after a web restart
   it can be unknown; then nothing is avoided either.

Rules 2 and 3 use the stuck-start discipline: two consecutive reconciles whose first and last are at
least a minute apart (and, for rule 2, `BOOT_AGENT_GRACE_MIN` apart), keyed by hostname and instance id;
any good sample starts the run over, a failed Vast list or agent read is no sample, and a web restart
only delays (the sightings live in memory). A record that reached ready is never judged. The release
uses the normal destroy path: usage reason "Boot failed", console end reason `slow_boot` or
`slow_download`, a `lifecycle: slow boot|slow download` warning with the instance and machine ids
(never a hostname), and `start_failure` in `GET /api/state`; the page says "The rented machine's network
is too slow (about N MB/s to the model host). It was released; try Start again, a different machine is
chosen." for `slow_download` (N, a number only, when known) and "The rented machine did not finish
starting up in time. It was released; try Start again, a different machine is chosen." for
`slow_boot`. The unreachable rule (`UNREACHABLE_DESTROY_MIN`, 15) still covers an agent that answered
once and then went silent.

5. **Faster downloads.** The agent fetches each model file over `DOWNLOAD_CONNECTIONS` (default 4,
   max 16; 1 = the old single stream) parallel byte ranges when the server answers HEAD with
   `Accept-Ranges: bytes` and the pinned size (files under 16 MiB use one), else in one stream; a
   server that ignores `Range` falls back to one stream in the same attempt. The .part file, the size
   check, the atomic rename and the retries stay; each range request asks the resolve URL again, so an
   expired signed CDN redirect is renewed.

Tuning: raise `NET_PROBE_MIN_MBPS` or lower `BOOT_MAX_DOWNLOAD_ETA_MIN` to be stricter (more releases,
fewer slow boots); keep `BOOT_MAX_DOWNLOAD_ETA_MIN` plus the rest of a boot (about 3 min) below
`BOOT_TIMEOUT_MIN` (the doomed-download rule then releases it in time). Measuring on a live instance:
`curl -sS -L -o /dev/null -r 0-25165823 -w '%{speed_download}\n' <resolve URL> --next -sS -L -o /dev/null
-r 25165824-50331647 -w '%{speed_download}\n' <resolve URL>` (the second number is what the probe uses).

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
- On the page the console has two parts. The server panel's boot summary (admins only, while an instance exists or
  the last one ended) shows the step list, a plain sentence for the running step, the ended notice and one
  "View log" button. That button opens the log itself in a dialog: full screen on phones, a large centred dialog
  from 900 px, with Pause, Copy, Clear view and Download .txt; Esc, the backdrop and Close close it and the focus
  returns to "View log" (or to the header's status pill when it was opened from the panel drawer, which it closes).
  The page keeps polling the console while the dialog is closed, because the summary needs it. The old fold toggle
  and its storage key `vast-comfy.console-collapsed` are gone.
- The phases come only from the instance's marker lines `[boot] step <n>/<m>: <id>` and
  `[boot] FAILED: <code>` (the fixed step list is defined once in `apps/core/src/console.ts`;
  the step list in `instance/bootstrap.sh` must equal it, a test checks). The steps, in order:
  `net_probe`, `install_tools`, `failsafe`, `tailscale`, `agent`, `nodes`, `models`, `comfyui`, `ready`.
  bootstrap prints each marker on its stdout and, best effort, on PID 1's stdout (what `vastai logs`
  shows); the rest of its output is not mirrored yet.

## Usage history

Admins open the usage history with the "History" button in the server panel (`GET /api/history`; members get 403):
one line per instance session with
the start time, duration, GPU, an estimated cost (duration x price per hour; disk and traffic are
billed separately) and why it stopped: the Destroy button (with who pressed it), the idle timeout,
the failsafe deadline, the hard cap, a failed boot or Start, an unreachable agent, or "disappeared"
when the cause is unknown (e.g. Vast removed it).

- On the page the history is a dialog, not a card in the main column: the History button (admins only, also when
  no instance exists; members never see it) sits in the server panel after the boot summary, above the Danger zone.
  The dialog works like the boot log dialog: full screen on phones, a centred dialog from 900 px, Esc, the backdrop
  and Close close it, the focus starts on Close, stays inside and returns to the History button (or to the header's
  status pill when it was opened from the panel drawer, which it closes); it is one of the overlays of which only one
  is open at a time. The history is read when the dialog opens and, while it stays open, again when the state turns
  none or ready; nothing is read while it is closed (no polling). The old fold toggle and its storage key
  `vast-comfy.history-collapsed` are gone.

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

**Paste an image.** In any tool that shows the image picker (Edit, the presets with reference slots, Upscale) Ctrl/Cmd+V attaches an image from
the clipboard, for example a screenshot, under the same limits as the file picker (count, type, size; the server checks again). Only a clipboard that
really holds an image is taken over: a text paste, a paste in a tool without images, or a paste while a dialog or drawer is open is left alone. Pasted
images are named `pasted-1.png`, `pasted-2.png`... NOT verified in real browsers (only jsdom): some browsers expose a copied file or image differently.

**Output size (UNVERIFIED on this model).** The Edit panel has a Size choice: "Same as the first image" (the default, the workflow
exactly as it ships, nothing extra is sent) or 1:1 / 3:4 / 16:9 / 9:16 (`edit.sizes` in the profile). A chosen size makes the web app add an
`EmptySD3LatentImage` node (`edit_size_latent`) and feed it to the sampler input named by `edit.size_latent` instead of the encoder's latent, which
follows the first reference. Nobody has checked that this model keeps the references' content when the latent has another aspect ratio: compare
the same edit with and without a size on a real instance. To remove the choice, delete `sizes` and `size_latent` from the profile's `edit:` section.

## Menu

The page lists every tool in a menu: a fixed sidebar of about 250 px from 900 px wide, below that an off-canvas
drawer opened by the "Menu" button of a sticky top bar (Esc, the backdrop and the close button close it; the focus
stays inside while it is open and returns to the Menu button). A search box on top filters the entries by title and
description, ignoring case. Each entry is one tool with its own panel (title, description, the style's labelled
image slots and hint, notes or prompt, quality/size/resolution, Advanced, the action button); the Results
and Gallery cards follow it (the usage history is a dialog opened from the server panel, see "Usage history"). The server status lives in a server panel on the right (below). Arrow keys, Home and End move through the entries; the chosen
entry is marked (`aria-current`) and remembered in this browser (`localStorage` key `vast-comfy.tool`, an entry id
only; an id the current menu does not have falls back to the first entry). "Use as reference" and "Upscale" on a
result or a saved image select the matching entry ("Make a video" selects Video, see "Video"). Requests are the same
as before the menu: an entry only picks the mode and the style (`/api/generate`, `/api/edit`, `/api/upscale` or
`/api/video`, with `style: {id, params}` for a style entry; video and upscale take no style).

The menu comes from the profile (`instance/profiles/image.yaml`) and is listed in `GET /api/state` under `menu`
(categories and entries in display order: id, title, description, icon, category, tool, style, available; never
templates, node ids or file names):

```yaml
menu:
  categories:                    # display order; ids are lower-case identifiers, titles at most 40 characters
    - {id: create, title: Create}
    - {id: edit, title: "Edit & combine"}
    - {id: enhance, title: Enhance}
  tools:                         # the built-in tools, at most one per mode (generate, edit, upscale)
    - {id: text_to_image, title: Text to image, description: "Describe a picture and generate it.", icon: image, mode: generate, category: create, order: 10}
    - {id: free_edit, title: Free edit, icon: wand, mode: edit, category: edit, order: 10}
    - {id: upscale, title: Upscale, icon: expand, mode: upscale, category: enhance, order: 20}
```

Every enabled style is an entry of its own (one per mode it lists; a style in two modes gets the ids
`<style>-generate` and `<style>-edit`). A style may set `category` (one of the menu's category ids; checked at load,
also for a disabled style), `description` (one line, at most 120 characters), `icon` and `order`; without a category
or icon it takes those of its mode's tool. Inside a category entries sort by `order` (lower first; entries without
one come last, tools before styles, in profile order). A profile without `menu:` gets one category "Tools" with the
three plain tools. Edit and upscale entries are left out while that mode is off on the server.

### Server panel, header and status widget

- From 1280 px the page has three columns: the menu (250 px), the tool panel, and the server panel (288 px) with its
  own scroll; the header runs across the page and the panel. The panel lists, top to bottom: the state line (the
  only live region), alerts and download progress (a failure reason first), uptime, cost so far and the idle
  shutdown countdown, the admin's main action (Start without an instance; Extend as a closed section that opens as
  the first choice when the idle shutdown is near; nothing while stopping), the boot summary (see "Boot console"),
  the admin's History button (see "Usage history") and the detail facts. The Danger zone is pinned at the bottom: Destroy (labelled "(retry)" after a failure; its
  confirmation names the cost so far and Cancel has the focus) and the untracked instances in a closed section.
  Members see the state, figures and facts only. "Hide" collapses the column; the choice is remembered in this
  browser (`localStorage` key `vast-comfy.panel`, `open` or `collapsed`, anything else means open) and applies
  only from 1280 px.
- Below 1280 px the panel is a right drawer opened from the header's status pill or the floating widget (backdrop,
  the page inert, Tab kept inside, Esc closes, the focus returns to the opener). It always starts closed. Only one
  overlay is open at a time: the menu drawer, the panel drawer, the boot log dialog or the history dialog; a
  confirmation sits above all of them (z-index: header 10, widget 12, backdrop 15, drawers 20, log and history
  dialogs 25, confirmation 30).
- The header: title, the status pill ("Ready", "Booting 42%", "Idle 3m", "Stopped", "Failed"; a button, never
  announced on every tick), the admin's Vast credit (see "Vast credit"), the name and Logout. Below 600 px the name
  and the credit leave the header (the credit becomes the first line of the panel) and Logout is a 44 px icon button.
- The floating widget (bottom right, above the home indicator) shows uptime, cost so far and the idle countdown
  while the panel is not on screen and an instance has an uptime, unless a drawer, a dialog or a confirmation is
  open. Members see it too. Its name is fixed ("Server status, open panel") and its numbers are hidden from screen
  readers; activating it opens the panel and focuses its heading.

To add a tool: add a style under `styles:` (see the next section) with `enabled: true`, and give it `category`,
`description`, `icon` and `order`; restart the web service. No page change is needed. A new category is a new
`menu.categories` item.

Icons are a closed set drawn by the page itself (inline SVG built in `apps/web/public/icons.ts`, nothing loaded from
outside): `image`, `wand`, `user`, `users`, `swap`, `shirt`, `restore`, `sparkles`, `expand`, `camera`, `brush`,
`film`. The
profile loader refuses any other name (the icon list in `apps/core/src/menu.ts`); the page draws an unknown name as
`sparkles`. A new icon needs both lists changed (a test checks that they match).

## Styles and "Use as reference"

Styles come from the `styles:` section of `instance/profiles/image.yaml`. The page shows each enabled style as its own
entry of the tool menu ("Menu" above) with a panel built from the style's parameters. The browser sends only
`style: {id, params}`; the server validates every value against the profile and takes the LoRA file, nodes and targets
from the profile, never from the request. A style with `enabled: false` is not listed and is refused.

"Anime / cartoon to real" (id `anything2real`) is ON (edit only). It is a LoRA style that also has its own prompt:
a style of either kind may declare `prompt_template` (exactly one `{prompt}`, the user's prompt becomes optional
"Notes", inserted once; with no notes the placeholder and its surrounding space disappear) and `references`.
Its LoRA `WarmBloodAban/Qwen-Image-2.1-LoRAs` / `Qwen2.1_Anything2RealCharacters.safetensors` is pinned in `models:` at
revision `c4ab5473bfdf585fc19cfd1e280f79d2b0c79947` (318 820 200 bytes, dest `models/loras/`); license Apache-2.0
(model card and HF tag, checked 2026-10-18). It downloads at boot with the other models; boot fails closed if the size
does not match. The loader refuses an enabled LoRA style whose models entry is missing or not in `models/loras/`. To
pin another style's LoRA (needs huggingface.co, so on the laptop): `python3 scripts/pin_model.py <owner/repo> <file>`.

### Cartoon to real

Exactly one image ("Image to convert"); the prompt is optional. The style sends: "Convert this anime or cartoon
illustration into a realistic photograph of a real person. Keep the same pose, facial expression, hairstyle and hair
color, outfit, background and composition. Natural skin texture and realistic lighting." plus any notes. LoRA strength
goes from 0.0 to 1.0 (step 0.05, default 0.7). Strength 0 means prompt only: the LoRA loader node is left out of the
workflow entirely (decision: safer than a loader at strength 0, which ComfyUI would still validate against the LoRA
file), so the result is the plain edit with this instruction. That alone already worked in spike S6
(`docs/spikes/S6-image-edit-references.md`: "Convert this anime illustration into a realistic photograph of a real
girl. Keep the same pose, hair color, outfit and composition.", 46.7 s, pose, hair, uniform and framing kept), so
compare 0 with 0.6 / 0.7 / 0.8 on the first live test. The model card advises 0.6 to 0.8 for characters and people.

Live test (UNVERIFIED): the LoRA node is inserted as `style_lora` between `lora.model_from` and `lora.model_to`;
whether that is right relative to `QwenImage21Cache` and the GGUF base is unknown. If the result is wrong, change those
two profile lines.

"Use as reference" on a result downloads the image from `/api/image/...` into the page and attaches it as a reference
in Edit (optionally with an edit style chosen). It goes through the same checks as an upload.

### Face swap (a preset style)

"Face swap" is a style without a LoRA (`kind: preset`, nothing to download), edit only. It sends the owner's tested
instruction from `prompt_template` (in `instance/profiles/image.yaml`); the user's prompt becomes optional notes that
replace `{prompt}` at its end, inserted once as plain text. The whole prompt must fit `GENERATE_MAX_PROMPT_CHARS`
(default 2000; the instruction alone is about 290 characters), else `prompt_too_long`. Its `references` rule needs
exactly two images: 1 = "Scene to keep" (body, pose, hair, clothes, background stay), 2 = "Face to use". The server
refuses any other number with `style_reference_count` before anything is uploaded; the page shows the two labelled
slots in order with a "Swap order" button and a hint that results depend on the model and that the person in the
second photo must consent. The quality preset stays whatever the user chose.

How to use: Edit images, choose "Face swap", attach the scene photo first and the face photo second (or press Swap
order), optionally add notes, press Edit. To change the wording, edit `prompt_template` (keep exactly one `{prompt}`);
to turn it off set `enabled: false`. Other presets can be added the same way: `kind: preset`, `prompt_template`
and/or params with node targets, optional `references: {min, max, labels}` (edit styles only), `hint` and
`defaults` (values the page pre-fills; see "Negative prompt, guidance and style defaults").

## Upscale

A third mode, "Upscale": one image in, a bigger one out (`ImageUpscaleWithModel`, then `ImageScaleBy` to trim 4x to
2x). It is ON with Real-ESRGAN x4plus: `Comfy-Org/Real-ESRGAN_repackaged` / `RealESRGAN_x4plus.safetensors` (ComfyUI's
own safetensors repackaging, so no pickle), revision `5fd49b7b278836f48af63ecd314d0f98ab336105`, 66 857 836 bytes,
dest `models/upscale_models/`, `model_factor: 4`, scales 2x and 4x. License BSD-3-Clause (repo card; upstream
xinntao/Real-ESRGAN is BSD-3-Clause), checked 2026-10-18. To change the model: check its license, run
`python3 scripts/pin_model.py <owner/repo> <file> models/upscale_models/` on the laptop, replace the models line and
set `upscale.model` and `model_factor` to match. Setting `enabled: false` turns the mode off (keep or drop the models
line: listed models are always downloaded).

Two sizes are bounded before anything is sent. `ImageUpscaleWithModel` always makes the model's own factor
(`upscale.model_factor`, 4 for an x4 model) before `ImageScaleBy` trims it, so input width x height x model_factor
squared must be at most `UPSCALE_MAX_INTERMEDIATE_PIXELS`, and input x factor squared (the result) at most
`UPSCALE_MAX_OUTPUT_PIXELS` (both default 32 MP, read at startup). With the defaults an x4 model takes inputs up to
about 2 MP (1448x1448) at any scale. Each scale's `factor` must equal model_factor x value, or the profile is refused. The image is validated like an edit reference (magic bytes, size,
pixels). Every result also gets an "Upscale" button next to "Use as reference". UNVERIFIED on a real instance: the
workflow `instance/workflows/image-upscale.json` has never run, and VRAM use of a large upscale is unknown.

## Video

A fourth mode, "Video" (menu category Create): a short clip from a prompt (text to video), or from a prompt plus
exactly one start image (image to video: attach it with the picker, paste it, or press "Make a video" on a result or
a saved image). One model does both, through native ComfyUI nodes only (no custom node): the workflow is
`instance/workflows/video-ti2v.json`, the profile's `video:` section maps its inputs. The page offers the sizes and
lengths of the profile (`video.sizes`, multiples of 32; `video.durations`, frames 4n+1 at `video.fps`) and an
optional seed; there is no quality preset, negative prompt or guidance (the workflow keeps its own). The job runs
like any other (same rate limit, same step counter over the websocket, previews if ComfyUI sends any) and the result
is shown in `<video controls playsinline>` with a Download link.

**It ships OFF.** Its three model files (about 18 GB) are not pinned yet: a cloud session cannot reach Hugging Face,
and a `models:` line is never written from memory. To switch it on (laptop):

1. Check the licence on the model card of each repo named in the comment under `models:` in
   `instance/profiles/image.yaml`.
2. Run the three `python3 scripts/pin_model.py ...` commands written in that comment and paste the printed lines
   into `models:` (if a file is not in the named repo the script says so; it is then in the other repackaged repo).
3. Set `video.enabled: true`. Both loaders now refuse the profile while a listed video file is missing from
   `models:` or has another dest ("video model ... is not listed in models"), so a forgotten pin stops the web app
   at startup and the instance at boot, never a job.
4. Set `VAST_DISK_GB` in `.env` to at least `requires.disk_gb` (80): about 33 GB of models plus the image. The
   instance's own disk check refuses a disk that is too small at boot.
5. Optional: `VIDEO_TIMEOUT_S` (default 2400, must stay below `WEB_JOB_TTL_S`, 3600, or the web app refuses to
   start), `VIDEO_MAX_BYTES` (largest result read from the instance, default 100 MiB) and `VIDEO_VIEW_TIMEOUT_S`
   (one result download, default 300 s). Images keep `GENERATE_TIMEOUT_S`, `WEB_IMAGE_MAX_BYTES` and
   `WEB_IMAGE_TIMEOUT_S`. These keys are read only while video is on.
6. Push, bump `REPO_COMMIT`, deploy, Start. The boot downloads the extra files (minutes more on a fast host, far
   longer on a slow one: the slow-download guard may release such a machine) and, with video on, also requires the
   section's `node_classes` from ComfyUI's `/object_info` before it reports ready: an image whose ComfyUI is too old
   for these native nodes fails the boot loudly with the missing class names (then a newer `VAST_IMAGE` is needed).

What the web app enforces: the body is strict (`prompt`, `size`, `duration`, optional `seed` and `image`); the start
image is checked like an edit reference (magic bytes, size, pixels, side, one frame) and uploaded under a name the
server chooses; the workflow is checked against the section at startup (every mapped input exists, the output node
is `SaveVideo`, the start image input is free, the graph loads every listed model file). The result is read from
`GET /api/video/{id}/{index}` (owner or admin, the instance that made it only), at most `VIDEO_MAX_BYTES`, and served
only when its first bytes are an mp4 (`ftyp` box of a video brand) or WebM (EBML DocType `webm`): the type comes from
those bytes, never from ComfyUI, with `nosniff`, `no-store` and a fixed file name. The page fetches it once and plays
it from a `blob:` URL (the CSP allows `media-src 'self' blob:`), so phones need no range requests. A video job is
never served by `/api/image`.

Not in phase 1, on purpose: **saving a video to the gallery.** The gallery's types, size limit and quotas are image
ones (`POST /api/gallery` answers `video_not_saveable` for a video job, the page shows no Save button and auto-save
skips videos); use Download. Also left out: a negative prompt or guidance for video, more than one start image, an
end frame, sound.

Waiting: ComfyUI runs one job at a time. While a clip renders (many minutes), image jobs of other people wait in
ComfyUI's queue, and their own `GENERATE_TIMEOUT_S` clock (600 s) runs from their submit: a long video can make a
queued image job time out on the page although ComfyUI still runs it later. The page warns that a video takes
several minutes and keeps the form busy until it is done (like every job). Idle shutdown does not hit a running
video (a busy queue resets the idle timer); the failsafe and the hard cap still do.

UNVERIFIED (nothing here has run against ComfyUI): the workflow graph and its node and input names (written from
the native nodes as documented, not exported from a running ComfyUI), whether `SaveVideo` with format mp4 / codec
h264 writes a browser-playable file and lists it under `images` in its history output, VRAM at 1280x704 x 121
frames on a 24 GB card, how long a clip takes on an A5000/3090/4090, the quality of the smaller sizes and of the
shipped negative prompt, playback on iPhone and Android, the real file sizes, and the longer boot.

## Live progress and preview

While a job runs, its result card shows "Step 12 of 25" with a progress bar (generate and edit; an upscale only shows
how long it has been running) and a small "Live preview (rough)" image that changes as the sampler works. The final
image replaces both. Every finished result also says how long it took ("Generated in 52 s"): ComfyUI's own execution
time from its history, else the server's time from submit to done; saved gallery images keep it in their metadata.

How it works: for each job the web process opens ComfyUI's websocket `/ws?clientId=<random id>` on the same tailnet
host and port as every other ComfyUI call and submits the prompt with that `client_id`, so ComfyUI sends that job's
`progress` messages and binary preview frames there. Only the newest step and the newest preview (JPEG or PNG by magic
bytes, at most `WEB_PREVIEW_MAX_BYTES`) are kept in memory with the job; the page polls `GET /api/generate/:id` about
once a second and fetches `GET /api/generate/:id/preview` only when `preview_seq` changed. The socket is closed when
the job finishes or fails, when the job is forgotten, on Destroy, and after `GENERATE_TIMEOUT_S` at the latest. It is
a small client written for this (no dependency): Node's built-in WebSocket buffers single frames of up to 2 GiB and
negotiates compression, so it could not bound what a rented host sends. Frame sizes are checked from the header
before anything is buffered; anything unexpected is ignored or closes that job's socket, never the job. Without a
socket (or with `WEB_PROGRESS_ENABLED=false`) jobs work exactly as before.

ComfyUI makes no previews by default. The instance boot writes the image's COMFYUI_ARGS variable with `--preview-method
$COMFY_PREVIEW_METHOD` (default `latent2rgb`) into `/workspace/.env`, which the image's `comfyui.sh` reads after
`/etc/environment`, right before it restarts ComfyUI (`boot comfy-args` in `instance/bootstrap.sh`). `latent2rgb`
needs no extra model and gives rough colour previews; `none` turns previews off (the step counter still works).
`taesd` gives much better previews but needs the Qwen-Image 2.1 TAESD decoder (`taeqi2_1_decoder`, per ComfyUI's
`latent_formats.py`) in `models/vae_approx/`; its download source is not known yet, so it is not in the profile.
Follow-up: find an official, licensed source for that file, pin it in `models:` with dest `models/vae_approx/`, then
set `COMFY_PREVIEW_METHOD=taesd`.

If that write fails (read-only or full disk), boot only logs a warning and ComfyUI restarts with its old arguments:
no previews, but the instance is not destroyed. An invalid `COMFY_PREVIEW_METHOD` still fails the boot.

UNVERIFIED live: the websocket through the tailnet (userspace Tailscale forwards plain TCP, so it should work), how
useful `latent2rgb` previews of Qwen-Image 2.1 look, and whether ComfyUI's step progress comes only from the sampler
node of our workflows. Also assumed from reading the image (vastai/comfy v0.41.0), not seen working: that
`/opt/supervisor-scripts/comfyui.sh` sources `${WORKSPACE}/.env` with `set -a` on every (re)start, and that
supervisord runs ComfyUI as root. Boot writes a new `/workspace/.env` with mode 0600 owned by root, so if the program
ran as another user it could not read the file and would start without previews. Check once on the first live boot
(SSH into the instance): `ps aux | grep main.py` must show `--preview-method latent2rgb` (or the configured method).

## Negative prompt, guidance and style defaults (Advanced)

The form has a collapsible "Advanced" section with a negative prompt and a guidance (cfg) slider. Both are optional
knobs of the profile: `generate.params` and `edit.params` may each map `negative_prompt` and `cfg` to a node input
(the shipped profile maps both in both workflows: generate node 6 `text`, the empty negative CLIPTextEncode, and
KSampler 8 `cfg`; edit `TextEncodeQwenImage21` 6 `negative_prompt` and KSampler 7 `cfg`), and `guidance: {min, max,
step, default}` bounds the slider (1.0 to 6.0 in steps of 0.5). `/api/state` says per mode which knobs exist
(`advanced.generate` / `advanced.edit`), and the page shows only those (nothing in Upscale).

Rules (decisions):
- **Untouched means unchanged.** The page sends no `negative_prompt` while the box is blank and no `cfg` while the
  slider sits at `guidance.default`; the server leaves the workflow's own values when a knob is absent, null or a
  blank text. `guidance.default` must equal the cfg in the workflows (1.0): the server refuses to start otherwise. So
  a user who does not open Advanced gets exactly the jobs of before.
- **Validated server side.** cfg must be a number on the guidance grid (`invalid_cfg`); the negative prompt must be
  text of at most `GENERATE_MAX_NEGATIVE_PROMPT_CHARS` (default 1000) after trimming (`invalid_negative_prompt`,
  `negative_prompt_too_long`). A knob the mode's workflow does not map is refused (`negative_prompt_unavailable`,
  `cfg_unavailable`), never silently dropped. Where a value goes always comes from the profile; a profile that maps a
  knob onto an input another param already fills is refused at load. The edit body limit counts both texts.
- **What is kept.** The job label (shown in the history and stored with a saved gallery image) gets ", guidance N"
  and ", negative prompt" when they were set. The negative text itself is not stored in the gallery metadata (the
  metadata is small and already holds the prompt; the label records that one was used).

The two fields are one set of values for the page, shared between Generate and Edit (switching the mode keeps what
was typed; a style's pre-fill is undone when the mode changes, see below). Each mode only sends a knob its workflow
takes. A style that pre-fills the negative prompt or guidance opens the Advanced section, so a pre-filled value is
never sent unseen; the page never closes it by itself.

Untouched requests are pinned by golden fixtures: `apps/core/tests/golden/golden-prompts.json` holds the exact
prompts master d929a9f submitted for every preset and size, edit with two references, "Anime / cartoon to real" at
0.7 and 0, face swap and upscale 2x/4x; the test fails on any byte of drift.

UNVERIFIED: what guidance above 1 or a negative prompt does to Qwen-Image 2.1 (GGUF Q4) in generate or edit has not
been tried on a real instance. In particular the edit workflow puts `QwenImage21Cache` (node 4) between the model
and the sampler: whether that cache behaves correctly when cfg above 1 makes the sampler run the conditional and the
negative branch every step (results, speed, VRAM) is unknown. Only ComfyUI's mechanics are known: at cfg 1.0 it skips the negative branch (so the
negative prompt is ignored there), and above 1.0 every step runs the model for both branches, so a job takes longer.
Compare a few values on the same seed before recommending any value or changing a default.

### Presets: one mechanism (styles), recipes folded in

Branch `feat/recipes-negative-prompt` (commit bf26818) added "recipes", a second preset system next to styles (its
own `recipe` request field, "Preset" menu, reference rule and a second face swap). There is now ONE: styles. The
`recipe` field is gone (a body that sends it is refused as `invalid_body`). What recipes had beyond styles became the
optional style `defaults`: `negative_prompt`, `cfg`, `preset`, `size` (generate styles) and `resolution` (edit
styles). They are checked at load (names offered by the profile, cfg on the grid, and for an enabled style the knob
mapped in every mode it is offered in; a default negative prompt longer than the request limit stops the server at
startup), listed in `/api/state` under each style, and the page pre-fills them when the style is chosen; the user can
change each. Leaving the style (or the mode) puts back what the fields held before, except the ones the user
changed. The server never applies defaults by itself: a job runs with what the request sends, so the request, the
label and what a user saw are the same thing.

The sample recipes are now sample preset styles, ON since commit 035d4f2 for the live test (each is a menu entry): Portrait photo, Family photo and Anime
illustration (generate; negative prompt and guidance 3.0 as defaults), Outfit swap (2 images), Restore old photo and
Photo to anime (1 image; a negative prompt default). Their wording is a first draft never compared on real output;
the generate templates were reordered so `{prompt}` is at the end (an empty note then leaves no stray punctuation).
The recipe "Face swap" was not ported: the live `faceswap` style (the owner's tested instruction) replaces it.
`anything2real` and `faceswap` are unchanged and have no defaults. Try each sample on a real instance and adjust its
`defaults` (or set `enabled: false` to withdraw it).

## Advanced server choice (Start dialog)

The location of the machine decides how fast a boot is (see "Slow boots"), so the Start dialog has a closed
"Advanced server choice" section (admins only, like Start itself):

- **Filters:** region (North/South America, Europe, Asia, Oceania, Africa; read from the country code at the end of
  Vast's location text such as "Quebec, CA", so an offer with an unknown place never matches a region), highest price
  per hour, lowest reported download speed and an order (cheapest, fastest download, most reliable). A filter can only
  NARROW the configured limits: a price above `VAST_MAX_DPH` is refused (`400 invalid_filter`), and the Vast query itself
  keeps `VAST_MAX_DPH`, `VAST_MIN_DOWNLOAD_MBPS` and the reliability minimum. An offer that reports no speed does not
  pass a minimum speed. The filter choice is remembered per device (localStorage `vast-comfy.start-filters`, validated on read).
- **Pick a server:** "Show matching servers" lists at most `START_OFFER_LIST_MAX` offers (price, place, speed,
  reliability) from `GET /api/offers`; "Automatic" (the default) rents the first of the order, a radio rents exactly that offer
  (`offer_id`). Offer ids are Vast offer ids; machine ids, host ids and addresses never leave the server.
- **Safety:** the bad-machine list (stuck or slow starts) is applied first, so a machine on it is neither listed nor
  rentable even by id. If the chosen offer vanished between the list and Start, or no longer passes the filters, the answer is
  `409 offer_gone`: no instance is created, nothing is billed, and the dialog reads the list again. Malformed filters are
  `400` and do not use the hourly Start limit.
- **Not verified live:** Vast's real `geolocation` text (the region parser expects a trailing two-letter country code), that every
  offer carries `inet_down` and `reliability2`, and the look of the section on a phone.

## Vast credit (admin)

Admins see the prepaid Vast credit in the page header (below 600 px: as the first line of the server panel).
It is tinted and spelled out: "used up" at or below $0, "low" under about two hours at the current price (at least
under $1 when there is no price), plain otherwise; "unavailable" stays neutral. The Start dialog warns when the
credit is known and lower than the estimate's maximum cost (Start stays possible). The page asks `GET /api/credit` about once a
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

## Custom instance image

The instance boots from `VAST_IMAGE`. By default that is the stock `vastai/comfy:v0.41.0-cuda-12.9-py312`, and
every boot builds the agent venv (`pip install` of the agent dependencies and the pinned `vastai`) and downloads
Tailscale (step `install_tools` and step `tailscale`). An optional custom image has these already in it. You build
and push it yourself to the GitHub Container Registry, as a public image with no secrets in it. No CI workflow
builds it.

**What is baked** (`instance/image/Dockerfile`, all of it outside `/workspace`):
- the agent venv at the `VENV_DIR` default, with the agent's third-party dependencies, its build requirements
  (from `instance/agent/pyproject.toml`) and `vastai==VASTAI_VERSION`. The agent package itself is NOT baked:
  its code still comes from the repository checkout at `REPO_COMMIT` at every boot;
- the Tailscale static tarball at the `TAILSCALE_VERSION` default, extracted into the `TAILSCALE_DIR` default
  (checked against the `.sha256` file published next to it);
- a marker `/opt/vastcomfy-image.json` that records the base image, the vastai and Tailscale versions, both
  directories and a hash of the agent dependency set.

**What is not baked:** the repository, ComfyUI custom nodes (phase 2, below), model files, any apt package
(bootstrap needs nothing the stock image lacks). The entrypoint, user and working directory are the base
image's. The base is exactly the schema default `VAST_IMAGE`. A Vast host that already has the stock image
cached pulls only the three small layers on top. A host without it pulls the whole stock image plus these
layers, which is no slower than today.

**How the boot decides** (`bootstrap.sh`, `install_runtime` and `install_tailscale`): each prints one line
to the bootstrap output (not yet mirrored to the boot console; HANDOFF Task C):
- `bootstrap: install_tools: baked image runtime used (...)`: the marker names the configured `VASTAI_VERSION`,
  the configured `VENV_DIR` and the same agent dependency set as the checked-out `pyproject.toml`, and the venv
  python and `vastai` are executable. Only the agent is then linked into the venv, offline
  (`pip install --no-index --no-deps --no-build-isolation -e`). If that link fails, the boot falls back to the
  full install.
- `bootstrap: install_tools: installing at boot (<reason>)`: everything else. Examples: the stock image (no
  marker), an unreadable marker, another vastai version, changed agent dependencies (a newer `REPO_COMMIT`), or
  a missing or non-executable binary. This is exactly today's install.
- `bootstrap: tailscale: baked image Tailscale used (...)`: the marker names the configured `TAILSCALE_VERSION`
  and `TAILSCALE_DIR`, and both binaries are executable.
- `bootstrap: tailscale: downloading at boot (<reason>)` or `existing install reused (<reason>)`: today's rule
  (reuse binaries already there, else download). One exception: binaries the marker names as ANOTHER version
  are downloaded over.

The marker never fails a boot. Without it, the stock image boots exactly as before.

**Tag rule:** `ghcr.io/<owner>/vast-comfy:<base tag>-vastai<VASTAI_VERSION>-ts<TAILSCALE_VERSION>-deps<hash>`,
where `<hash>` is the first 12 hex digits of the sha256 of the sorted agent dependency set. Every pin is read
from the schema defaults and `pyproject.toml`, so a changed pin gives a new tag. Rebuild after changing
`VAST_IMAGE`, `VASTAI_VERSION`, `TAILSCALE_VERSION` or the agent dependencies. Until you rebuild, the old image
still works: the boot sees the difference and installs at boot.

**Build, push, switch** (from the laptop, against the LOCAL Docker daemon: run `unset DOCKER_HOST` first, so
the build does not go to the homelab):

    docker login ghcr.io -u <github-user>          # token with write:packages, typed at the prompt
    scripts/build-image.sh --owner <github-user>   # builds linux/amd64, does not push
    scripts/build-image.sh --owner <github-user> --push

The script pushes only with `--push`. It refuses to run without `--owner`. It reads and prints no secret. At
the end it prints the exact line for `.env`, for example `VAST_IMAGE=ghcr.io/<owner>/vast-comfy:<tag>`. After
the FIRST push, make the package public on GitHub (Packages, `vast-comfy`, Package settings, Change
visibility, Public). Vast is given no registry credentials. Then put the printed line in `.env` and recreate
the web service (`docker compose up -d`, see "Deploying"). The next Start uses the custom image. Compare the
boot console timings with a stock boot.

**Roll back:** remove the `VAST_IMAGE` line from `.env` (or set it back to the stock tag) and recreate the
web service. The next Start uses the stock image. Nothing in the schema changed: merging this code changes
nothing in production until you set `VAST_IMAGE`.

**Phase 2 (not done):** bake the ComfyUI-GGUF node and its requirements. This first needs a check of where
ComfyUI lives inside the image and whether `/workspace` is overlaid at runtime. Model files stay out of the
image.

**UNVERIFIED (nothing was built, pushed or booted):** the Dockerfile has never been built (the session that
wrote it had no Docker daemon or registry access). Also unverified:
- the real boot-time saving;
- that the base image's `python3 -m venv` and `curl` are the ones bootstrap uses;
- the `.sha256` file name next to the Tailscale tarball;
- whether the base image's `/workspace` overlay matters for phase 2;
- whether Vast pulls a public GHCR image without credentials;
- whether Vast treats a non-`vastai/` image any differently (the template, the portal, the entrypoint).

## Already verified

The Vast create/destroy request shapes and the instance label were verified in the T13 spike.

## NOT verified yet

- Video ("Video"): off and unpinned; never run. The workflow, the node classes, the mp4 output, VRAM, time per clip,
  phone playback, file sizes, disk and boot time are all unchecked.

- The custom instance image ("Custom instance image"): never built, pushed, pulled by Vast or booted.

- Slow boots ("Slow boots"): the thresholds were chosen from two measured boots, not tuned on many; the
  probe's early destroy through the stock CLI before `install_tools` (the same path `onstart.sh` relies
  on) has not run on a real instance; whether the markers reach `vastai logs` through `/proc/1/fd/1`;
  byte ranges through Hugging Face's redirect to its CDN and its xet bridge (`cas-bridge.xethub.hf.co`):
  the agent falls back to one stream when HEAD does not promise ranges, but the speed gain of 4
  connections is unmeasured; why `apt`/`pip` in `install_tools` stalled on the California machine.

- Negative prompt and guidance above 1 on Qwen-Image 2.1 (generate and edit): mapped and validated, never run
  on a real instance; see "Negative prompt, guidance and style defaults".

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

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

    DOCKER_HOST=tcp://192.168.88.113:2375 docker compose build --pull
    DOCKER_HOST=tcp://192.168.88.113:2375 docker compose up -d

`--pull` matters: `up --build` alone reuses the cached `node:24-alpine` layer, so a Node.js security release
(for example CVE-2026-111497, the Brotli decoder, fixed in 22.23.4 / 24.22.1 / 26.12.1) never reaches the image.
`scripts/check-node-version.js` also stops the build when either stage has an unfixed Node.js.

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
`start failed: StartError (internal: ts_key_mint_failed/<detail>)` in the log, and the cause as
`tailscale token request failed: ...` or `tailscale key request failed: ...` (a fixed code plus
the HTTP status, never the provider's text).

Network errors, timeouts and 5xx answers of the token and key requests are retried (at most 3
attempts, 1 s then 2 s back-off plus jitter, logged as `tailscale ... retry 2/3 after ...`) within
one budget of `TS_RETRY_TOTAL_S` seconds per Start (default 15, 1..120). A 4xx (refused client,
missing scope, rejected tag, rate limit) is never retried. The read-only Vast offer search is
retried the same way (3 attempts on a network error or 5xx); the instance create call never is.

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

## Start failed: what the messages mean

A failed Start keeps the Start dialog open with a plain-English line, then `Reason: <reason>` (and
`(<detail>)` for a Tailscale key failure). The same reason and detail are in the web log as
`start failed: StartError (internal: <reason>[/<detail>])`. Failures of Vast, Tailscale, the
instance or ComfyUI answer HTTP **424**, never 502/504: Cloudflare replaces an origin 502/504 with
its own error page, and the text below would be lost. A line saying "a proxy replaced the answer
(HTTP 502)" therefore means the answer never came from the routes: the web container is down or
unreachable through the tunnel (look at the Status card and `docker logs`).

| reason (detail) | Meaning | What to do |
| --- | --- | --- |
| `ts_key_mint_failed` (`tailscale_unavailable`) | The server could not reach the Tailscale API (network error, timeout or 5xx after the retries, or a 429). Nothing was rented. | Check the server's internet connection; try again in a minute. |
| `ts_key_mint_failed` (`oauth_failed`) | Tailscale refused the OAuth client, or only one of the two OAuth keys is set. Nothing was rented. | Check `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET` (both set) and the Auth Keys write scope. |
| `ts_key_mint_failed` (`key_rejected`) | Tailscale refused to create the key. Nothing was rented. | Check `TS_OAUTH_TAG` and that the tag is in the ACL `tagOwners` for the client. |
| `ts_key_mint_failed` (`invalid_response`) | Tailscale sent an unusable answer. Nothing was rented. | Try again in a minute; see the log. |
| `ts_key_missing` | No OAuth client and the `TS_AUTHKEY_FILE` key file is missing or empty. Nothing was rented. | Set the OAuth client, or put a key in the file. |
| `vast_unavailable` | The Vast offer list could not be read (network problem at the server or a Vast outage; retried). Nothing was rented. | Try again in a minute; check the server's internet connection. |
| `config_invalid` | A start setting is missing or invalid. Nothing was rented. | Compare `.env` with `.env.example`. |
| `vast_rejected` | Vast refused the create (the offer may have just been taken). Nothing was rented. | Try Start again. |
| `create_uncertain` (code `start_uncertain`) | Vast's answer to the create was lost: the machine may exist. | Do not start again yet; reconcile links or releases it within minutes (Status card). |
| `registry_failed` | The machine was created but could not be recorded and was destroyed. | Check the Status card, then try again. |
| `unexpected` | Anything else. | Check the Status card before retrying; see the log. |

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
is shown in `<video controls loop playsinline>` (it repeats until paused; it does not start by itself) with a Download link.

**It is OFF until `VIDEO_ENABLED=true` in `.env`** (a configuration key of the web app; the profile has no switch).
Its three model files (about 18 GB) are pinned in `models:` of `instance/profiles/image.yaml` (the owner ran
`scripts/pin_model.py` and checked the licences on 2026-10-22). To switch it on:

1. Set `VIDEO_ENABLED=true` in `.env`. The web app then offers the Video tool and passes `VIDEO_ENABLED=true` to
   every instance it starts (with `false`, the default, nothing about video is sent, so an image-only instance env
   is unchanged). Both loaders refuse the profile while video is on and a video file is missing from `models:` or
   has another dest ("video model ... is not listed in models"), so a missing pin stops the web app at startup and
   the instance at boot, never a job.
2. Do not put `enabled:` into the profile's `video:` section: both loaders refuse a section that has one, with a
   message pointing to `VIDEO_ENABLED` (a line that looks like a switch but does nothing would mislead).
3. While video is off, the pinned video files are never downloaded: every boot leaves them out (also out of the
   early network probe and its "all models present" check), so an image-only boot is the same as before they were
   pinned.
4. Optional: `VAST_VIDEO_DISK_GB` (default 80, the disk rented for a start with the video models),
   `VIDEO_TIMEOUT_S` (default 2400, must stay below `WEB_JOB_TTL_S`, 3600, or the web app refuses to start),
   `VIDEO_MAX_BYTES` (largest result read from the instance, default 100 MiB) and `VIDEO_VIEW_TIMEOUT_S` (one result
   download, default 300 s). Images keep `GENERATE_TIMEOUT_S`, `WEB_IMAGE_MAX_BYTES` and `WEB_IMAGE_TIMEOUT_S`.
5. Push, bump `REPO_COMMIT`, deploy.

### Video models at Start, or later on demand

The video files are **not** downloaded at every boot. The admin's Start dialog has **Include video models** (shown
only where the server offers video; unticked by default; the last choice is remembered in this browser, key
`vast-comfy.start-video`):

- **Unticked (default): exactly the boot of before.** Same disk (`VAST_DISK_GB`), same offer search and price, no
  `INCLUDE_VIDEO_MODELS` in the instance env; the agent downloads only the image models, its disk check counts only
  them, boot requires only `provides_node_classes`, and the overall download progress and slow-download ETA leave
  the video files out.
- **Ticked:** the GPU list, the offers and the estimate are searched and priced for the larger disk (the larger of
  `VAST_DISK_GB` and `VAST_VIDEO_DISK_GB`), the Start body carries `video_models: true`, the instance gets
  `INCLUDE_VIDEO_MODELS=true` and downloads the video files at boot like every other model (pinned size, ranged
  download, disk check) and also requires the section's `node_classes` before ready. The boot takes longer
  (about 18 GB more): on a slow host the slow-download guard may release the machine; raise
  `BOOT_MAX_DOWNLOAD_ETA_MIN` if that happens too often.

**On demand** (changed your mind after the start): in the Video tool an admin sees "This instance was started without
the video models" and a **Download video models (about N GB, several minutes)** button (`POST /api/video-models`,
admin only: it uses the instance's disk and network for minutes). Members see "Ask an admin to download them" and no
button. The agent (`POST /video-models`) first checks, before a single byte: the instance is ready (not booting or
stopping), ComfyUI has the section's node classes (`video_nodes_missing` otherwise: the instance image is too old),
and the disk holds the missing files plus `DISK_MARGIN_MB` (`disk_insufficient` with the GB needed and free
otherwise: an instance started with the default 50 GB disk may well be too small; start the next one with the box
ticked). It then downloads only the missing files in the background with the boot's own code (pinned size, ranged
download into a `.part` file, atomic rename), single-flight (a second press changes nothing). `/api/state`
`video.models` shows `not_installed`, `downloading` (bytes, percent; the page shows "Downloading the video models:
4.5 GB of 18.0 GB (25%)"), `ready` or `failed` (with the reason and a retry button for admins). Image jobs keep
running meanwhile. A running download counts as activity: the idle shutdown does not stop the instance under it (the
failsafe deadline and the hard cap still apply). Cut off (agent or instance restart): nothing half-written is ever
used; pressing the button again fetches only what is missing.

**Video jobs are never queued while the files are missing:** `POST /api/video` answers 409
`video_models_not_ready` (not installed, still downloading, failed, or not reported) and Make video stays disabled
until `video.models.state` is `ready`.

**ComfyUI and the new files:** ComfyUI's loader lists are read from its model folders, and recent ComfyUI versions
cache them per folder and re-read a folder when its modification time changes, so a running ComfyUI should offer the
new files without a restart. This is from reading ComfyUI's code behaviour as remembered, NOT verified on the
instance image. The agent therefore checks instead of assuming: after the download it asks
`/object_info/<class>` of every video node class and requires each new file name to be listed; if one is not, the
state is `failed` with "ComfyUI does not list ... yet; it needs a restart". It never restarts ComfyUI itself (that
would cut off running image jobs). The node classes are native, so they exist from ComfyUI's start; only the files
are new.

### A model link instead of the pinned diffusion model

An admin may give a **link to a different video diffusion model**: the "Video model link (optional)" field under
"Include video models" in the Start dialog (enabled only when the box is ticked; `video_model_url` in the Start
body, `VIDEO_MODEL_URL` on the instance), or the "Model link (optional)" field next to "Download video models" in the
Video tool (`url` of `POST /api/video-models`). The field is never stored in the browser. Empty means the pinned model
(an on-demand download without a link also drops an active link). The link replaces only the diffusion model slot
(the video `models` entry with dest `models/diffusion_models/`); the text encoder and VAE stay the pinned entries.

**A linked model is NOT integrity-pinned or licence-checked** (the page says so next to both fields and, for admins,
under the Video tool while a linked model is in use). There is no sha256 to compare with: the instance computes the
sha256 of what arrived and reports it (boot log line "linked video model ... sha256 ... (not pinned)", the agent log,
`/api/state` `video.model.sha256` for admins).

Rules (untrusted input; checked by the web app before anything is rented or sent, and again on the instance):
https only; ASCII only; no user info, no port, no percent-encoding, no query except `?download=true`, no fragment;
the host must be exactly one of `VIDEO_MODEL_LINK_HOSTS` (default `huggingface.co`; IP literals, `localhost`, a
trailing dot and look-alike hosts such as `huggingface.co.evil.com` are refused); the path must be
`<owner>/<repo>/resolve|blob/<revision>/<path to file>` (a `blob` link becomes the `resolve` link); the file must end
in `.safetensors` or `.gguf` (never a pickle format). The instance then downloads it with the boot's own downloader
from the `resolve` URL, and every request of that download, each redirect hop included, is checked before it is sent:
https, port 443, no user info, no IP literal, a host that is a link host or inside `VIDEO_MODEL_LINK_REDIRECT_DOMAINS`
(default `huggingface.co,hf.co`, which covers Hugging Face's CDN hosts). The size comes from a HEAD on the instance
(capped by `VIDEO_MODEL_LINK_MAX_BYTES`, default 20 GiB); the disk check runs before the download. After the download
the file must be what its extension says (a GGUF file starts with `GGUF`; a safetensors file starts with the length
of a JSON header that opens with `{` and fits in the file), else it is deleted and refused (`model_link_bad_file`).
A linked file may not have the name of a pinned model (`model_link_name_clash`: it would overwrite it). The web app
passes its `VIDEO_MODEL_LINK_*` values to the instance with every start of a profile with video.

Error codes: `invalid_model_link`, `model_link_host_not_allowed`, `model_link_unsupported_type`,
`model_link_name_clash` (400) and `model_link_too_large`, `model_link_unreachable`, `model_link_redirect_not_allowed`,
`video_gguf_loader_missing` (409, from the instance). At boot a refused link fails the boot (`download_failed`, the
code in the boot log) and the machine is released: the web app checks everything it can before renting, but the
size, the redirects and the file itself can only be checked on the instance.

The active link is kept on the instance (`video_link.json` in its state dir) and reported in the agent's status;
video jobs then load the linked file: the web app names it in the workflow copy wherever the workflow named the
pinned diffusion file. A `.safetensors` link keeps the native `UNETLoader`; a **`.gguf` link turns that node into
`UnetLoaderGGUF`** (input `unet_name` only), and the instance requires that node class before the download (on
demand: `video_gguf_loader_missing`) or at boot (`verify-nodes` fails, the boot log says `video_gguf_loader_missing`).

**GGUF is UNVERIFIED for this model.** The instance installs only the ComfyUI-GGUF fork pinned in `nodes:` for the
image model, `leejet/ComfyUI-GGUF` (its pin is unchanged). Whether that fork can load this video model's GGUF files
is unknown; the GGUF loader usually used for this video model is the original `city96/ComfyUI-GGUF`, which could not
load the image model ("Unknown model architecture", the reason the fork is used). If the fork cannot, the download and the node check still succeed, and the first video job
fails at the loader: the page shows "Failed: UnetLoaderGGUF: ..." with ComfyUI's message (for the image model the
original pack said "Unknown model architecture"). No second GGUF node pack is installed by this change.

Decision: a link does **not** make `VIDEO_ENABLED=true` possible without the pins. Enabling still requires all
three video files pinned in `models:`. Relaxing that only for the diffusion slot would change both profile loaders and
the readiness rules for a small gain: the text encoder and VAE need the same `pin_model.py` step anyway, and the
pinned diffusion model remains the default when no link is given.

### Video families (a second model: 14B, 4 steps)

Besides the `video:` section (the base family, "Fast (5B)") the profile can list more video model families under
`video_families:`. The shipped profile has one: `wan22_a14b`, "Quality (14B, 4 steps)": the two-expert 14B model
(a high-noise expert for the first two steps, a low-noise expert for the last two) in fp8, sped up by the official
lightx2v 4-step LoRAs. Unlike the base family it has a workflow per mode:
`instance/workflows/video-14b-t2v.json` (text to video) and `video-14b-i2v.json` (image to video, exactly one start
image). Each graph: two `UNETLoader` (the experts), a `LoraLoaderModelOnly` on each (strength 1.0), a
`ModelSamplingSD3` on each (shift 5), `CLIPLoader` (type wan; the same text encoder file as the base family, pinned
once), `VAELoader` (`wan_2.1_vae.safetensors`, a new pin), `EmptyHunyuanLatentVideo` (text) or `WanImageToVideo` with
the start image (image), then two `KSamplerAdvanced` (high expert steps 0-2 with leftover noise, low expert steps
2-4), cfg 1, euler/simple, `VAEDecode`, `CreateVideo` (16 fps) and `SaveVideo`. The page offers only prompt, size
(832x480, 480x832), length (about 3 s or 5 s: 49 or 81 frames), seed, the start image and the model choice; steps,
cfg, sampler, LoRA strength and shift are the family's (`fixed:` in the profile sets the strength and shift on every
job; the step split and cfg are in the workflow files). The negative prompt is the same fixed English text as the
base family's workflow.

**Switching it on (owner):**

1. Its files are pinned (owner, 2026-10-24, with `scripts/pin_model.py`, licences checked by the owner) in
   `models:` of the profile: the four fp8 experts and the four 4-step LoRAs from
   `Comfy-Org/Wan_2.2_ComfyUI_Repackaged` (revision `ee6f4a4...`), the VAE from `Comfy-Org/Wan_2.1_ComfyUI_repackaged`
   (revision `123acf1...`); the text encoder is the 5B family's own pin. The LoRAs are Comfy-Org's repackaging
   because their names are unique; the lightx2v originals share the names `high_noise_model` / `low_noise_model`
   across text and image to video and would overwrite each other in `models/loras/`.
2. Set `VIDEO_FAMILIES=wan22_a14b` in `.env` (besides `VIDEO_ENABLED=true`; a csv, apps and instance). The web app
   passes it to every instance it starts. Both loaders refuse the profile while a listed family has a file missing
   from `models:` or in another folder (same message as the base section), and refuse an id that names no family.
   With only `VIDEO_ENABLED=true` (and `VIDEO_FAMILIES` empty, the default) everything is as before: the base family
   only, and the 14B family is validated but never downloaded or offered.
3. Disk: the family's own files are 62.8 GB (four experts of 14.3 GB, four LoRAs of 1.2 GB, the 0.25 GB VAE, and
   the extra LoRAs' 0.15 GB and 0.31 GB), 69.5 GB with the shared text encoder. **With the default `VAST_DISK_GB=50` a start with the 14B family alone rents 120 GB,
   with both families 131 GB** (the 5B alone stays at `VAST_VIDEO_DISK_GB`, 80): the Start dialog rents
   max(`VAST_DISK_GB`, `VAST_VIDEO_DISK_GB`, `VAST_DISK_GB` + the ticked families' pinned files in GB, a shared file
   counted once), computed from the pins, so `VAST_VIDEO_DISK_GB` needs no change for it. An on-demand download onto
   an instance started without the family checks the free disk first (`disk_insufficient`).
4. Push, bump `REPO_COMMIT`, deploy.

**Choosing and downloading.** In the Start dialog, with "Include video models" ticked, "Video models to include"
lists every family (the base one ticked): the ticked ones are downloaded at boot (`video_families` in the Start body,
`VIDEO_BOOT_FAMILIES` on the instance; a boot downloads exactly the chosen families' files, a file two families share
once), and the disk, the offers and the estimate follow the choice. The base model link of the Start dialog needs
the base family ticked (it replaces that family's model). In the Video tool a "Model" select appears (only when there
is more than one family); its sizes and lengths are the chosen family's. A family that is not on the instance shows
the same note as the base one: admins get "Download video models (about N GB, several minutes)"
(`POST /api/video-models` with `family`), members "Ask an admin to download them"; Make video stays disabled until
that family's files are there. One video download runs at a time on an instance (`video_download_busy` otherwise).

**Extra LoRA.** A family may offer optional extra LoRAs (profile `extra_loras:` of the family; one per job). The
14B family ships two, both **image to video only** (`modes: [image]`) and at strength 1.0, as read from the model card
of `Aisha-AI-Official/wan2.2-calisthenic-moves` on 2026-10-26:

- "Calisthenic moves" (`calisthenic_moves`): `calisthenics_moves_high_noise.safetensors` (pinned 2026-10-24, 153 MB)
  on the high-noise branch only. The card says it is a LoRA for Wan 2.2 I2V A14B only, trained on the high-noise
  expert only (3 clips of 80 frames), with scale 1.0 (and shift 4 in the author's own setup); it probably works only
  at the camera angle it was trained on, may ignore very different prompts and may force the look of the training
  characters. It gives no trigger words (`trigger_words` stays empty), only example prompts, one of which is in the
  entry's description.
- "Calisthenic moves + low-noise LoRA" (`calisthenic_moves_low`): the same high-noise LoRA plus
  `DR34ML4Y_I2V_14B_LOW_V2.safetensors` from `Aisha-AI-Official/backups` (pinned 2026-10-26, 307 MB) on the
  low-noise branch, a third-party LoRA its author describes for nudity. Same limits.

**Neither repo states a licence**: the owner decides whether to use them. Both files are part of the family's
`models:` and are **downloaded with the family** (no separate download state; the family's disk and progress figures
include them: 460 MB on a 69.5 GB family). With the 14B family chosen the Video tool shows "Extra LoRA" (None by
default), a strength (0 to 1, step 0.05, starting at the entry's default) and a note with the description and the
trigger words. The job then carries `extra_lora` (the entry's id) and `extra_lora_strength`; the web app adds a
`LoraLoaderModelOnly` node (`video_lora_high`, and `video_lora_low` for an entry with a low file) right after the
branch's 4-step LoRA node (`lora_after:` of each mode names it) and before `ModelSamplingSD3`, with the file name from
the profile only. It is refused (400) for the base family or a family without extra LoRAs
(`extra_lora_unavailable`), for an unknown id (`unknown_extra_lora`), for a mode the entry does not list
(`extra_lora_mode`: a text job, without a start image, with either shipped entry) and for a strength outside 0 to 1
or without a LoRA (`invalid_strength`). An entry has `id`, `title`, `description`, `modes` (text and/or image),
`high` and/or `low` (`{file}`, one of the family's `models` in `models/loras/`), `strength` (0.6 when left out) and
`trigger_words`. **UNVERIFIED:** how these LoRAs stack with the lightx2v 4-step LoRAs (the card's scale 1.0 was for
the author's own setup: lower the strength if results break), and the low-noise LoRA's effect together with the
calisthenics one.

**Expert links (GGUF).** For a family an admin may link both experts of one mode instead of the pinned fp8 files:
choose "Text to video" or "Image to video" under "Expert links for", then give the high-noise and the low-noise link
(`mode` and `links: {high, low}`; both together or none: one link alone is refused on the page, by the web app and
by the instance). Each link follows every rule of the base link above (host allow-list, https, redirect check,
size cap, magic bytes, sha256 reported, not integrity-pinned), plus: two links may not name the same file, nor a
pinned file or another linked file. A `.gguf` expert turns its own `UNETLoader` into `UnetLoaderGGUF` (needs the
GGUF loader node, `video_gguf_loader_missing` otherwise). The links of the other mode are kept; a family download
without links returns the whole family to its pinned files. The links are kept on the instance in
`video_links_<family>.json` (state dir), apart from the base model's link. The Start dialog has no expert links:
they are given on demand only (decision: two links per mode in the Start dialog would double its fields for a rare
case). **Whether the pinned `leejet/ComfyUI-GGUF` fork loads the 14B experts' GGUF files is UNVERIFIED.**

UNVERIFIED (nothing ran): both 14B graphs and every node and input name in them (written from memory of the native
nodes, not exported from ComfyUI; the file names they load are the pinned ones), the 4-step recipe values
(strength 1.0, shift 5, cfg 1, euler/simple, the 0-2 / 2-4 split), 16 fps, the 49/81 frame lengths, VRAM of the two
14B fp8 experts on a 24 GB card (ComfyUI loads one expert at a time; it may still need offloading), the time a clip
takes (`VIDEO_TIMEOUT_S` 2400 s is a guess for both families), the disk need above, and GGUF support for these
experts.

### Extra LoRAs added from the page (admins)

Admins can add extra LoRAs to a video family that takes them (today the 14B family) **from the page, by Hugging Face
link**, without a profile change, a pin, a commit or a deploy: Video tool -> **Manage LoRAs** (shown to admins only,
built by the page only for them). The form takes a title, an optional description, the video model, text and/or
image to video, a default strength (0 to 1), a "Hidden: admins only" box, optional trigger words, and a link for the
high-noise and/or the low-noise branch. An added LoRA then appears in the Extra LoRA select of that family like the
profile's own (`POST /api/video` `extra_lora` takes its id) and is inserted the same way (a `LoraLoaderModelOnly`
after the 4-step LoRA of each branch it has a file for). Edit changes the title, description, modes, strength, hidden
flag and trigger words; the links and the family are fixed (delete and add again). Delete asks first.

- **Store.** `LORA_STORE_PATH` (compose: `/data/extra-loras.json`, next to the registry; atomic writes, mode 600, a
  version and a size cap). At most `LORA_MAX_ENTRIES` (20) entries; adds, changes and deletes share
  `LORA_WRITE_RATE_LIMIT_PER_HOUR` (30) per admin. A file that cannot be read is never overwritten: nothing is listed
  and every write answers `lora_store_unavailable` until it is fixed or removed (an entry whose link is no longer
  allowed, e.g. after `VIDEO_MODEL_LINK_HOSTS` changed, makes the whole file unusable: remove that entry by hand).
  The profile's own `extra_loras:` are never listed, changed or deleted through the API; an added LoRA never reuses
  their ids.
- **Ids and file names are the server's.** The id is generated (`lora_` and 8 hex digits) and the file on the
  instance is `xl_<id>_<high|low>.safetensors`; nothing a user types ever becomes a file name, so a link cannot
  overwrite a pinned file or another LoRA. The instance accepts only that name shape and refuses a pinned model's name.
- **Links.** The model-link rules exactly (https, the hosts of `VIDEO_MODEL_LINK_HOSTS`, a resolve/blob file path, no
  user info, port, percent-encoding or IP literal), and `.safetensors` only (a `.gguf` LoRA is refused). Checked by
  the web app before anything is stored, and again on the instance, which also checks every redirect hop
  (`VIDEO_MODEL_LINK_REDIRECT_DOMAINS`), the size from a HEAD (`LORA_LINK_MAX_BYTES`, 2 GiB), the free disk, and the
  file's safetensors header after the download. **NOT integrity-pinned or licence-checked**: the page says so next to
  the link fields; the sha256 of what arrived is computed on the instance and shown to admins (with the size) in the
  list. The web process never contacts the model host itself; size and sha256 come from the instance (per instance,
  so they are not stored).
- **Download to the instance.** Added LoRAs are NOT part of the boot's pinned set and do not change the boot's disk
  estimate. When an instance serves, the web app sends it the whole wanted set (every added LoRA of an enabled
  family, hidden ones too: they are small): at once after an add or a delete, and from the state poll whenever the
  set the agent reports differs (digest), at most every `LORA_SYNC_MIN_INTERVAL_S` (30 s). The agent
  (`POST /loras`) downloads the missing files in the background through the same single download slot as the video
  models (one download at a time: a video model download is refused with `video_download_busy` meanwhile, and a LoRA
  sync during a video download waits for it), into a staging folder ComfyUI does not read, then moves each file into
  `models/loras/` under its server-chosen name. State per LoRA: not on the instance yet, downloading, on the instance,
  or download failed (with the reason, retried by the next sync). Each file needs the free disk first, and all of them
  together at most `LORA_TOTAL_MAX_BYTES` (instance key, 10 GiB; `lora_total_too_large`). Decision: all of them, on
  demand after the boot, rather than at boot or at first use: the boot and its disk estimate stay exactly as before,
  a new instance gets them a few seconds after it is ready, and a job never has to wait for a download.
- **Using one.** A job with an added LoRA whose files are not on the instance is refused with
  `extra_lora_not_ready` (409), never queued.
- **Deleting.** The entry goes at once (no new job can use it). The instance deletes the file at the next sync only
  while ComfyUI's queue is empty (a running job may be using it); otherwise at a later sync or download pass, or with
  the instance.

**Hidden LoRAs (admins only).** A LoRA marked hidden is for admins only, and the **server** enforces it (the page's
JavaScript is the same for everyone and the API can be called directly):

- `/api/state` never lists a hidden LoRA for a member, whatever the request carries. For an admin it lists them only
  when the request carries the header `x-reveal-hidden: 1`, which the page sends after the reveal gesture: **three
  quick taps (within about a second) on the Video tool's title**. Three more taps hide them again; a reload forgets it
  (nothing is stored in the browser). Before the gesture the page holds no trace of them (no option, badge or text).
  The gesture is a convenience: keyboard users and anyone else can manage hidden LoRAs in Manage LoRAs, which lists
  them with a "hidden" badge.
- A member's job naming a hidden LoRA gets exactly the answer of an unknown id (`unknown_extra_lora`), so its
  existence does not leak. An admin's job may use one without the reveal header.
- A hidden LoRA's title, description, id and file names never appear in a member's state, in a job label (the label
  of a job with a hidden LoRA leaves its title out), in error messages or in the web app's info log lines. Jobs are
  per user (an admin can read other people's jobs, not members), and videos are not saved to the gallery or the
  usage history, so no other place shows them.
- Decision: hidden is a flag of added LoRAs only. The profile's `extra_loras:` cannot be hidden: the profile is in the
  repository anyone with repo access reads, and a hidden-in-the-page entry in a public file would suggest a secrecy it
  does not have.

**Hidden means "not shown to members", NOT secret**: the store file sits on the web host's data volume, the files on
the instance (with their links in the agent's state file and the download in its log), and anyone with access to the
server, the instance or the Vast account can see them.

UNVERIFIED (nothing ran): a real linked LoRA download on an instance (Hugging Face's redirect hosts as allowed by
`VIDEO_MODEL_LINK_REDIRECT_DOMAINS`, the HEAD size after the redirect), ComfyUI listing a new file in `models/loras/`
without a restart (checked after each download; a file it does not list fails with "needs a restart"), how an added
LoRA stacks with the 4-step LoRAs, and the gesture on phones (taps on a heading). Links carry no licence check.

### Longer clips (experimental, about 12 s)

Both families offer a third length, **"About 12 s (experimental)"**: 289 frames for the 5B (24 fps) and 193 frames
for the 14B (16 fps), both 4n+1 (profile `durations`, `experimental: true`; the loaders allow at most 289 frames).
The two shorter lengths are unchanged. The page labels it and, while it is chosen, warns: "Longer than the model was
trained for (about 5 s): quality may drop and it may run out of memory or time out." `/api/state` marks it with
`experimental: true` (frames are never sent to the browser).

What to expect and what to change (nothing ran yet, so these are estimates):

- **Time.** A 12 s clip has 2.4 times the frames of a 5 s one and the model's attention grows faster than linearly
  with the frames, so expect several times the 5 s time. `VIDEO_TIMEOUT_S` (default 2400 s, 40 min) may be too short
  for 289 frames at 1280x704 on a 24 GB card, but it is not certain to be, so the default is unchanged. If 12 s jobs
  time out on the page, raise both, keeping the rule that the job timeout is shorter than the job memory (the web
  app refuses to start otherwise): for example `VIDEO_TIMEOUT_S=5400` and `WEB_JOB_TTL_S=7200`. A longer
  `WEB_JOB_TTL_S` also keeps image jobs (and access to their images) in memory longer. A job the page gives up on is
  not cancelled in ComfyUI: it keeps the GPU until it finishes, and image jobs queued behind it wait (each with its
  own `GENERATE_TIMEOUT_S`). The idle shutdown does not stop a busy instance; the failsafe deadline and the hard cap
  still do.
- **Memory.** VRAM grows with the frames: 289 frames at 1280x704 may well not fit in 24 GB. **Try 832x480 first**
  (the "faster" sizes of the 5B; the 14B has only 832x480 and 480x832). An out-of-memory error shows as a failed job.
- **Result size.** `VIDEO_MAX_BYTES` (100 MiB) should be enough: an h264 mp4 of 12 s at 1280x704 is likely in the
  range of 5 to 50 MB at usual encoder settings. The settings `SaveVideo` uses (bitrate or quality) were not read, so
  this is an estimate; a larger file is refused with `video_too_large` (raise `VIDEO_MAX_BYTES` then).
  `VIDEO_VIEW_TIMEOUT_S` (300 s) is ample for that over the tailnet.

UNVERIFIED: quality beyond about 5 s (the models were trained for about 5 s clips; motion may loop or degrade), VRAM
for 289 and 193 frames, the time per clip, and the result size.

### What the web app enforces

The body is strict (`prompt`, `size`, `duration`, optional `seed` and `image`); the start image is checked like an
edit reference (magic bytes, size, pixels, side, one frame) and uploaded under a name the server chooses; the
workflow is checked against the section at startup (every mapped input exists, the output node is `SaveVideo`, the
start image input is free, the graph loads every listed model file). The result is read from
`GET /api/video/{id}/{index}` (owner or admin, the instance that made it only), at most `VIDEO_MAX_BYTES`, and served
only when its first bytes are an mp4 (`ftyp` box of a video brand) or WebM (EBML DocType `webm`): the type comes from
those bytes, never from ComfyUI, with `nosniff`, `no-store` and a fixed file name. The page fetches it once and plays
it from a `blob:` URL (the CSP allows `media-src 'self' blob:`), so phones need no range requests. A video job is
never served by `/api/image`.

Not in phase 1, on purpose: **saving a video to the gallery.** The gallery's types, size limit and quotas are image
ones (`POST /api/gallery` answers `video_not_saveable` for a video job, the page shows no Save button and auto-save
skips videos); use Download. Also left out: a negative prompt or guidance for video, more than one start image, an
end frame, sound, cancelling an on-demand download (it ends with the instance), links for the text encoder or VAE.

Waiting: ComfyUI runs one job at a time. While a clip renders (many minutes), image jobs of other people wait in
ComfyUI's queue, and their own `GENERATE_TIMEOUT_S` clock (600 s) runs from their submit: a long video can make a
queued image job time out on the page although ComfyUI still runs it later. The page warns that a video takes
several minutes and keeps the form busy until it is done (like every job). Idle shutdown does not hit a running
video (a busy queue resets the idle timer); the failsafe and the hard cap still do.

UNVERIFIED (nothing here has run against ComfyUI or a real instance): the workflow graph and its node and input
names (written from the native nodes as documented, not exported from a running ComfyUI), whether `SaveVideo` with
format mp4 / codec h264 writes a browser-playable file and lists it under `images` in its history output, VRAM at
1280x704 x 121 frames on a 24 GB card, how long a clip takes on an A5000/3090/4090, the quality of the smaller sizes
and of the shipped negative prompt, playback on iPhone and Android, the real file sizes, the longer boot with the
box ticked, the on-demand download on a real instance (its speed beside running image jobs, the disk left on a
default 50 GB instance, and whether ComfyUI lists the new files without a restart), the price difference of
the larger disk, and model links: the CDN host names Hugging Face redirects to today (assumed inside
`huggingface.co`/`hf.co`), the HEAD size after its redirect, a real linked download, and whether the pinned
ComfyUI-GGUF fork loads this video model's GGUF files (it may well not; see above).

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

## Stop generating

A running or waiting job's card has a **Stop** button (every kind: generate, edit, upscale, video). An image job stops
at once; a video job asks first ("Stop this video?", the work so far is discarded). The card then says "Stopped"
(not an error); the prompt and every setting stay as they were and the form takes a new job right away. The page
still allows one job at a time: Generate stays disabled while a job runs ("You can submit another when it finishes"),
and Stop is the way to free it early (unchanged on purpose: queuing several 20-minute 14B videos would block the
instance for everyone).

`POST /api/generate/{id}/cancel` (empty JSON body; owner or admin, like reading the job; someone else's job is 404;
rate limited per identity at `WEB_GENERATE_RATE_LIMIT_PER_HOUR`, counted apart from generating):

- the prompt is still waiting in ComfyUI's queue: `POST /queue {"delete": [id]}`, then the queue is read again (it may
  have started in between, then it is interrupted);
- it is the running prompt: `POST /interrupt {"prompt_id": id}`, sent only after `GET /queue` showed that the running
  prompt IS this job's. While another job runs, nothing is interrupted;
- neither (it finished just before): `409 job_finished`, and the next poll shows the result. A job with no history
  and nothing in the queue (lost), or whose instance is gone, is simply marked cancelled.

ComfyUI records an interrupted prompt as an error: a poll that reads it before the stop answers fails the job for a
moment, and the stop then still turns it into `cancelled` (the page holds a failure that arrives while its Stop runs and
shows it only if the Stop itself fails). The job then reads `{"status": "cancelled"}` (terminal, not a failure; a late poll answer cannot overwrite it; its
progress socket is closed; nothing of it is served, so partial outputs are discarded). A cancelled job answers 200
again (idempotent); a done or failed one 409 `job_finished`. ComfyUI unreachable or an error answer: 424
`comfy_unavailable`, the job unchanged (try again). No job failure is counted anywhere (the usage history counts
instance sessions, not jobs), so a stop is no failure there either.

ComfyUI's interrupt stops the node running on the instance at that moment; the jobs queued behind the stopped one
keep running. UNVERIFIED on the owner's ComfyUI (in `vastai/comfy:v0.41.0`): that `/interrupt` reads `prompt_id`
(newer ComfyUI versions only interrupt when it names the running prompt; an older one ignores the body and interrupts
whatever runs, so a prompt that finished between the queue read and the interrupt could cost the NEXT job its run, a
window of one request), that `/queue {"delete"}` removes a waiting prompt, and how long an interrupted 14B sampler
takes to stop (ComfyUI checks for an interrupt between steps).

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
  phone playback, file sizes, disk and boot time, the on-demand download and whether ComfyUI lists new model files
  without a restart are all unchecked.

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

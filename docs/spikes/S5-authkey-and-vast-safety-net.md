# S5: automatic Tailscale auth keys and a Vast-side safety net

- Date: 2026-10-17
- Method: Vast CLI inspection (`vastai --help`, `create/destroy/stop instance --help`, `show scheduled-jobs`) and Tailscale documentation. No instance rented, no OAuth client created: cost $0.
- Spec sections affected: 9 (auth keys), 12 (residual risk 1), 14 (`TS_API_CREDENTIAL`)

## Question
1. Can the bot create a short-lived, single-use, ephemeral, tagged Tailscale auth key per instance through an OAuth client?
2. Does Vast have a server-side scheduled destroy (a safety net that works even if the instance, the homelab and the failsafe are all dead)?

## Findings
### Vast: no server-side destroy timer (answer 2: NO)
- The only scheduling in the CLI is `vastai cloud copy ... --schedule HOURLY|DAILY|WEEKLY` and `take snapshot`; `show scheduled-jobs` / `delete scheduled-job` list and delete those jobs. `create instance`, `stop instance` and `destroy instance` have no time, end-date or lifetime option (the only "end" in `create instance --help` is `--cancel-unavail`).
- Residual risk 1 (homelab, watchdog and failsafe all dead) therefore stays open. Remaining mitigations are the ones already in the spec: small prepaid balance, auto top-up off, `failsafe_alive` monitored, failsafe kept minimal.
- Cheap extra mitigation worth adding to the runbook: keep the prepaid balance low enough that a forgotten instance cannot cost more than the user accepts; a 24 GB instance at ~$0.24/h burns $5.76/day.

### Tailscale auth keys (answer 1: YES per documentation, not yet measured)
- Official docs: an OAuth client with the `auth_keys` scope can create auth keys through `POST /api/v2/tailnet/:tailnet/keys`; an OAuth client with that scope must be given one or more tags, and the same tags must be passed in the call. Request fields (community sources): `description`, `reusable`, `ephemeral`, `preauthorized`, `tags`, `expirySeconds`.
- The admin console limits a key's lifetime to 1-90 days; the API's minimum `expirySeconds` is **not documented** in what was read and is not measured.
- Ephemeral nodes are removed automatically after going offline; the delay is not documented.
- OAuth clients do not belong to a user and do not expire; the client secret is the long-lived credential and must live only on the homelab (`TS_API_CREDENTIAL`, secret, apps component).

## Verdict: PARTIAL (documentation only)
The design stays as specified: the bot creates a single-use, ephemeral, tagged key (`tag:gpu`) with a short `expirySeconds` per instance. Unverified: the exact minimum expiry and the removal delay of ephemeral nodes; both are measured when sub-project 3 (bot) first creates a key (needs an OAuth client created by the user).

## Decisions and config/spec changes
1. Fallback in the spec (manual or longer-lived key) is not needed yet, but remains the fallback if the API refuses short expiries: use `expirySeconds` at the documented minimum.
2. Residual risk 1 is documented as unmitigable on the Vast side; no spec change beyond the runbook note about the prepaid balance.
3. `TS_API_CREDENTIAL` stays a secret of the apps component only; it never goes into instance env.

## Follow-ups
- Sub-project 3: create the OAuth client (scope `auth_keys`, tag `tag:gpu`), measure the minimum `expirySeconds` and the ephemeral removal delay on the first real key, record them here.

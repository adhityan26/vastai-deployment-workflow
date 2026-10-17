# Web interface: deferred follow-ups

Triage from the final whole-branch review (2026-10-17). Everything here is CAN-WAIT; the must-fix items were fixed in commit 2a3353f.

## Verify at the first real boot (Task 12)
- Vast REST shapes for create (`PUT /asks/{offer}/`, runtype `ssh_direc ssh_proxy`, `cancel_unavail`) and destroy (`DELETE /instances/{id}/`) are UNVERIFIED against the live API.
- Vast accepting `:` in the label `vastcomfy:<hostname>`; read the label back after create. If Vast rewrites it, an ambiguous create becomes invisible to reconcile.
- The v1 `/instances/` response shape (`start_date` present, units) and pagination.
- Container-to-tailnet reachability and single-label MagicDNS names (`vast-xxxx`) from the web container.
- Authentik outpost: `X-authentik-jwt` header, `groups` claim, and the JWKS/issuer/audience values.

## From the first real boot (docs/spikes/T13-boot-end-to-end.md)
- Re-measure /view download speed from the homelab (the laptop was saturated during the test); keep `WEB_CONNECTION_TIMEOUT_S` larger than `WEB_IMAGE_TIMEOUT_S`.
- Optional later: image format choice (WEBP/JPEG) in the web page and bot.
- The page shows `ready` for ~1.5 min after the instance self-destroyed; surface Vast status/agent-unreachable more prominently.

## Small hardening
- lifecycle: guard the hard-cap fallback with `> 0` for `vast_start_date`; the comment at lifecycle.ts:86-87 overstates what boot_timeout covers after a web restart; `stop_grace_period` budget should include the agent `/destroy` call (HTTP_TIMEOUT_S_APPS): raise to ~75s or document; small in-memory leaks (pending-destroy set, miss counter) per Start.
- `view()` can throw if `registry.active()` fails (500, fails closed).
- Cache `view()` / the Vast list for a few seconds (every tab polls Vast + agent every 5 s; a Vast 429 pauses reconcile enforcement). Do before team use.
- Instance stuck in `exited`/`offline` after `ready` is bounded only by the hard cap; disk billing continues.
- Start while unknown project-labelled instances exist: currently a warning only; consider refusing.
- Reusing a spent single-use TS_AUTHKEY wastes a paid boot (instance self-destroys at the Tailscale step).
- Registry keeps old agent tokens of `gone` records (file mode 0600).
- `COMFY_PORT`/`AGENT_PORT` are not sent to the instance (documented as fixed).
- Per-owner job cap (one member can evict others' jobs with 4+ accounts); image route buffers up to WEB_IMAGE_MAX_BYTES; `/view` shares the 10 s timeout (fixed on fix/real-boot-1: `/view` uses `WEB_IMAGE_TIMEOUT_S`).
- Move the hardcoded Vast search defaults (verified, external:false, num_gpus:1) into the schema with the bot (3b).

## Tests and polish
- T1: weak "no secret values" assertion; loadSchema does not reject min>max or duplicate names.
- T2: `in` vs `Object.hasOwn` for mapped inputs; upper bounds for steps/sizes; duplicate node+input mapping; Python/TS float and int-key divergence; invalid_seed/invalid_prompt tests.
- T3: direct test of the save() backstop; chmod-based test fails as root.
- T6: entry with outputs but no status never counts done; NaN/string seed tests.
- T8: alg-mismatch, `aud` array, `nbf`, resolver-throws tests.
- T9: tests for scrubbed extend/destroy-unknown refusals.
- T10: page tests for the pending->done path, state-poll scheduling/backoff, hostile unknown-instance status; content-type assertions for css/svg/webmanifest; modal focus trap; listener cleanup; 180px PNG apple-touch-icon.
- T11: assert the previous core `main` value in the Dockerfile repoint (or use `exports` conditions); pin `node:24-alpine` digest at first real deploy; stronger deploy tests (USER, HEALTHCHECK, tmpfs, no-new-privileges, :ro key mount, .dockerignore); `.dockerignore` `**/` prefixes.

## Out of scope here (other sub-projects)
- Watchdog duties: destroy when `failsafe_alive` is false, `failed` state that never changes, Discord alerts (sub-project 2).
- Bot, roles for the team server, OAuth key minting (sub-projects 3b/4).

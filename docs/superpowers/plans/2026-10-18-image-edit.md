# Image Edit With Reference Images Implementation Plan

**Goal:** Besides text-to-image, a user can attach up to N reference images plus an instruction and get an edited/combined image (anime to realistic, clean up, "put the jacket of image 2 on the girl of image 1").

**Spec / facts:** `docs/spikes/S6-image-edit-references.md` (working API-format graph on stock ComfyUI 0.41.0, about 47-54 s on an RTX 3090 at 1024), `docs/HANDOFF.md`.

**Architecture:** One new member route `POST /api/edit` carries the prompt, preset, resolution, an optional seed and the reference images **as base64 inside the JSON body**. The browser never talks to ComfyUI. The server validates every image (magic bytes, size, decoded pixel count), uploads each one to ComfyUI `POST /upload/image` under a **server-chosen** file name, builds the edit workflow from the profile (one `LoadImage` node per reference, `images.image_k` inputs on the encoder node), submits it, and registers the job in the same `JobStore` as generate jobs. Polling (`GET /api/generate/:id`) and image download (`GET /api/image/:id/:index`) are reused unchanged except that the job remembers which workflow template it ran with (to find its `SaveImage` node).

**Deviation from the handoff, on purpose:** the handoff suggested multipart. JSON+base64 keeps every existing gate as is (JSON-only, strict ajv schema, Origin/Sec-Fetch-Site CSRF rule, no new dependency, no multipart parser on the attack surface) and is trivial to test with the fake servers. The cost is about 33 % more bytes on the wire; the route gets its own body limit derived from the config so the global `WEB_BODY_LIMIT_BYTES` stays small for every other route.

## Global constraints

- Everything in the earlier plans applies: config only through `contracts/config-schema.yaml` and `apps/core/src/config.ts`; `python3 scripts/check_config_usage.py apps instance` stays green; English comments/commits; no secrets in logs, errors or responses; default-deny `/api/*`; `no-store`; strict CSP (the page may use `blob:` images only, already allowed); never `--no-verify`; do not push or merge without the owner.
- **No browser-chosen file names reach ComfyUI.** Uploaded names are `edit-<random hex>.<ext>`, generated per request. The extension comes from the detected type, never from the request.
- **References are not stored by the web process.** They live in request memory only; after the upload to the instance nothing remains. They stay in the instance's ComfyUI `input/` folder until the instance is destroyed (instances are ephemeral).
- **Fail closed on validation:** any reference that is not a PNG/JPEG/WebP by magic bytes, exceeds `EDIT_REFERENCE_MAX_BYTES`, has more than `EDIT_REFERENCE_MAX_PIXELS` pixels, or whose header cannot be parsed is refused with a fixed error code **before** anything is sent to the instance.
- Limits come from config: `EDIT_MAX_REFERENCES` (default 4; the official template supports 10), `EDIT_REFERENCE_MAX_BYTES` (default 8 MiB), `EDIT_REFERENCE_MAX_PIXELS` (default 16 777 216), `EDIT_REFERENCE_TYPES` (csv, default `png,jpeg,webp`). Upload timeout reuses `WEB_IMAGE_TIMEOUT_S`.
- Edit requests share the per-identity generate rate limit (`WEB_GENERATE_RATE_LIMIT_PER_HOUR`).

## File structure

```
contracts/config-schema.yaml, .env.example     EDIT_* keys
instance/workflows/qwen-image-edit.json        flattened S6 graph without LoadImage nodes (added in code)
instance/profiles/image.yaml                   edit: section, workflows list, provides_node_classes
apps/core/src/profile.ts                       parse the edit section, buildEditPrompt()
apps/core/src/references.ts                    sniff/validate references (magic bytes, pixels)
apps/core/src/http.ts, comfy.ts                raw bodies in request(); ComfyClient.uploadImage()
apps/core/src/generate.ts                      edit() service (validate, upload, build, submit)
apps/web/src/routes.ts, store.ts               POST /api/edit, job kind/template, per-route body limit
contracts/web.openapi.json                     /api/edit and the state fields
apps/web/public/{index.html,model.ts,ui.ts,style.css}   Generate/Edit switch and reference picker
tests next to each module
```

## Tasks

1. **Config and profile.** Schema keys, `.env.example`, the workflow file, `edit:` profile section (workflow, params prompt/steps/seed/resolution, references node mapping, resolutions list), `provides_node_classes` gains `TextEncodeQwenImage21` and `QwenImage21Cache`, `workflows:` gains the edit file. The Python agent ignores `edit:`; its suites stay green.
2. **Core.** `references.ts` (sniff PNG/JPEG/WebP, read pixel dimensions from the header, enforce limits), raw-body support in `http.request`, `ComfyClient.uploadImage` (multipart built by hand, response `name` must be a safe plain file name), `buildEditPrompt` (deep copy, insert `ref_k` LoadImage nodes, set `images.image_k` on the encoder, params), `edit()` service. Tests with fakes: every refusal, nothing sent to ComfyUI on a refusal, names are server-chosen, ordering is preserved (image_1 first), partial upload failure aborts the job.
3. **Web route.** `POST /api/edit` (member): schema (`prompt`, `preset`, `resolution`, `seed`, `images` array of plain base64 strings (no `data:` URL prefix, no wrapping object) bounded by `EDIT_MAX_REFERENCES`), per-route `bodyLimit`, same readiness/limiter/error mapping as generate plus fixed codes for reference problems, job stored with its kind, poll route picks the right template, `/api/state` exposes `edit` limits (max references, max bytes, types, resolutions) so the page needs no constants, OpenAPI and its route-list test updated.
4. **Page.** A Generate/Edit switch (same card), reference picker (file input, multiple, thumbnails via object URLs, remove button, count/size/type checked in the browser too, mobile friendly), resolution select when more than one, base64 encoding off the main flow, results land in the existing history with a note "N references". textContent only, no inline script/style.
5. **Verification.** `npx vitest run apps --exclude '.worktrees/**'`, `npm run typecheck`, `python3 scripts/check_config_usage.py apps instance`, `cd instance/agent && python -m pytest -q -W error` (profile/boot suites), `npm run build:page -w @vast-comfy/web`. A real end-to-end check (start an instance, edit with 2 references) must be done by the owner.

## Not in scope / unverified

- Prompt enhancer (extra 9B model), more than 2 references in a live run, transparent outputs, 2K inputs, quality at 10 steps (S6).
- Client-side downscaling of large photos before upload (a later optimisation; the server limits already bound the cost).
- Gallery/save of results (other work item).

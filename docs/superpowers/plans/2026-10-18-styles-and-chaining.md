# Styles and Chaining Implementation Plan

**Design:** `docs/superpowers/plans/2026-10-18-styles-and-chaining-design.md` (agreed with the owner; read it first). This plan covers its steps 2 and 3: the styles framework with the first style (Anything to Real) and the "Use as reference" chaining button. Usage history (step 1) and the live LoRA test (step 4) are other work.

## Decisions made while planning (differences from the design, and why)

1. **The LoRA is downloaded at boot with the other models, not on demand per job.** The agent already downloads every entry of `models` with size checks; a style's LoRA is simply one more `models` entry (`dest: models/loras/`), so the Python agent needs no change and the web's overall download progress counts it. The file is small (about 0.32 GB, seconds). On-demand download needs a new agent endpoint, a "preparing" job state and its own tests, which cannot be verified without a live instance; do it when a style is large enough to matter.
2. **The shipped style is `enabled: false` until the LoRA is pinned.** A `models` entry needs an exact `revision` and `size_bytes`, and the agent fails the boot (`download_failed`) when a size does not match. This environment cannot reach Hugging Face, so the values cannot be read here, and a guessed value would break every boot. `scripts/pin_model.py <repo> <file>` (run on the owner's laptop) prints the exact `models:` entry; adding it and flipping `enabled: true` turns the style on. A disabled style is validated but never offered, never downloaded and never accepted by the API.
3. **Where the LoRA loader sits is data, not code.** `lora.model_from` is the node whose MODEL output the loader takes and `lora.model_to` the node input that is rewired to the loader's output. The design marks this placement unverified; the live test may change it by editing the profile only.

## Architecture

- **Profile `styles:`** (`id`, `title`, `modes` ⊆ {generate, edit}, `enabled`, `lora: {file, model_from, model_to}`, `params`). Params are a closed set (`float`, `int`, `choice`, `bool`); a param's `target` is `lora_strength` (the loader's `strength_model`) or a `{node, input}` of the workflow. Validated at load; an enabled style must have its LoRA file in `models`.
- **Request:** `generate` and `edit` bodies take an optional `style: {id, params}`. The service resolves it against the profile (style exists, enabled, allowed in this mode; every param known, typed, in range, on its step; missing params take their default) before anything is sent to ComfyUI. Node classes, input names and file names inside workflows never come from the request.
- **Workflow:** `applyStyle` inserts one `LoraLoaderModelOnly` node (`style_lora`) and rewires the consumer; it refuses (`workflow_mismatch`) when the nodes it needs are not in the workflow.
- **API/state:** `/api/state` gains `styles` (id, title, modes, params with limits and defaults; never file names or nodes); OpenAPI updated. Job labels include the style title so a saved image says how it was made.
- **Page:** a style sub-menu under the active mode (Standard + the styles that list the mode) and a parameter panel built from the state (range/number/select/checkbox). One style per job. The choice and each style's values are kept while the page is open.
- **Chaining:** every result and gallery image gets "Use as reference". The page re-reads the image it already can reach (`GET` same-origin, with the session cookie), turns it into a `File` and adds it to the edit references through the existing picker path (type/size/count checks), after switching to Edit and the chosen style. No new server surface.

## Tasks

1. Core: `styles.ts` (schema parse, `resolveStyle`, `applyStyle`), profile wiring (`Profile.styles`), `generate()`/`edit()` accept `style`; shipped profile gets the disabled `anything2real` entry; tests.
2. Web: state `styles`, `style` in both bodies, job labels, OpenAPI; tests. Python: the agent profile loader still loads the shipped profile (new test).
3. Page: sub-menu and parameter panel; "Use as reference" for results and gallery items; tests.
4. `scripts/pin_model.py` + test; runbook and handoff; full verification; PR.

## Not in scope / unverified

Upscale and Camera angle (design section 6); combining two LoRAs; on-demand LoRA download; that the LoRA works on the GGUF base and at which strength (live test, owner's laptop); the loader placement (see decision 3).

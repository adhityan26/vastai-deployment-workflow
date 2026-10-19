# Golden ComfyUI prompts

`golden-prompts.json` holds the exact prompts the generate, edit and upscale services submitted on
master d929a9f for untouched requests (`cases.ts` lists them). `golden.test.ts` replays them on the
current code and fails on any difference. To regenerate on purpose: create a worktree of the reference
commit, copy `cases.ts` and `capture.test.ts.txt` (renamed to `capture.test.ts`) into its
`apps/core/tests/golden/`, run `npx vitest run apps/core/tests/golden/capture.test.ts` there with
`GOLDEN_OUT=<path of golden-prompts.json>` set, and review the diff.

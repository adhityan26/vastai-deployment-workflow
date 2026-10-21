// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";

// The step counter and the live preview of a running job. Timers are captured so each poll is run by hand.

const INDEX = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");

type Reply = { status?: number; body?: unknown; raw?: string; type?: string; delayMs?: number };
type Handler = Reply | (() => Reply);

const STATE = {
  state: "ready", role: "member", record: null, vast: null, vast_error: null,
  agent: { state: "ready", reason: null, queue: { running: 0, pending: 0 }, gpu: {}, failsafe_alive: true, destroy: { pending: false, attempts: 0 } },
  agent_error: null, agent_unreachable: false, failed: null, destroy_failed: null, dph: 0.3, uptime_s: 1, cost_so_far: 0,
  progress: null, gpu_name: null, download: null, remaining: { idle_s: 100, failsafe_s: 100, hard_cap_s: 100 }, unknown: [],
  presets: [{ name: "p", steps: 25 }], sizes: [{ name: "s", width: 512, height: 512 }],
  upscale: { scales: ["2x"], max_bytes: 1000, max_pixels: 1_000_000, types: ["png"] },
};

let app: App | null = null;
let routes: Record<string, Handler> = {};
let calls: string[] = [];
let timers: { fn: () => void; ms: number }[] = [];
let nowMs = 0;
let created: string[] = [];
let revoked: string[] = [];

async function mount(extra: Record<string, Handler>) {
  routes = { "GET /api/me": { body: { name: "T", username: "t", role: "member" } }, "GET /api/state": { body: STATE }, ...extra };
  app = mountApp(document, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      const h = routes[`${method} ${path}`];
      if (h === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: "not found" } }), { status: 404 });
      const r = typeof h === "function" ? h() : h;
      nowMs += r.delayMs ?? 0;
      if (r.raw !== undefined) return new Response(r.raw, { status: r.status ?? 200, headers: { "Content-Type": r.type ?? "image/jpeg" } });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as typeof fetch,
    now: () => nowMs,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  await app.ready;
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Run the newest job poll timer (the other timers are state polls and the clock). */
async function nextJobPoll(): Promise<number> {
  const i = timers.findLastIndex((t) => t.ms <= 2000 && String(t.fn).includes("pollJob"));
  const t = timers.splice(i, 1)[0]!;
  t.fn();
  await flush();
  return t.ms;
}
const jobPolls = () => timers.filter((t) => String(t.fn).includes("pollJob"));

beforeEach(() => {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
  calls = [];
  timers = [];
  nowMs = 1_000_000;
  created = [];
  revoked = [];
  let n = 0;
  window.URL.createObjectURL = (() => {
    const url = `blob:preview-${++n}`;
    created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  window.URL.revokeObjectURL = ((url: string) => void revoked.push(url)) as typeof URL.revokeObjectURL;
});
afterEach(() => {
  app?.stop();
  app = null;
});

async function submitGenerate() {
  q<HTMLTextAreaElement>("#prompt")!.value = "a red fox";
  q<HTMLFormElement>("#gen-form")!.requestSubmit();
  await flush();
}

describe("a running job", () => {
  it("shows the step counter and a live preview that changes, fetched only when preview_seq changes, then the final image", async () => {
    const answers: Reply[] = [
      { body: { status: "pending", progress: null, preview_seq: 0 } },
      { body: { status: "pending", progress: { step: 12, max: 25 }, preview_seq: 1 } },
      { body: { status: "pending", progress: { step: 13, max: 25 }, preview_seq: 1 } },
      { body: { status: "pending", progress: { step: 20, max: 25 }, preview_seq: 3 } },
      { body: { status: "done", images: [{ index: 0, url: "/api/image/job-1/0" }], seconds: 40, queued_seconds: 1 } },
    ];
    await mount({
      "POST /api/generate": { status: 202, body: { id: "job-1" } },
      "GET /api/generate/job-1": () => answers.shift()!,
      "GET /api/generate/job-1/preview": { raw: "JPEGDATA", type: "image/jpeg" },
    });
    await submitGenerate();
    expect(q("#history .job-step")).toBeNull();
    expect(q("#history .live-preview")).toBeNull();
    expect(q("#history .job-elapsed")!.textContent).toBe("Running for 0 s");

    nowMs += 5_000;
    await nextJobPoll();
    expect(q("#history .job-step")!.textContent).toBe("Step 12 of 25");
    const bar = q<HTMLProgressElement>("#history progress")!;
    expect([bar.value, bar.max]).toEqual([12, 25]);
    expect(q("#history .job-elapsed")!.textContent).toBe("Running for 5 s");
    expect(q<HTMLImageElement>("#history .live-preview img")!.src).toBe("blob:preview-1");
    expect(q("#history .live-preview figcaption")!.textContent).toBe("Live preview (rough)");

    await nextJobPoll(); // same preview_seq: no new fetch
    expect(calls.filter((c) => c.endsWith("/preview"))).toHaveLength(1);
    expect(q("#history .job-step")!.textContent).toBe("Step 13 of 25");

    await nextJobPoll();
    expect(calls.filter((c) => c.endsWith("/preview"))).toHaveLength(2);
    expect(q<HTMLImageElement>("#history .live-preview img")!.src).toBe("blob:preview-2");
    expect(revoked).toEqual(["blob:preview-1"]);

    await nextJobPoll();
    expect(q("#history .live-preview")).toBeNull();
    expect(q("#history progress")).toBeNull();
    expect(q("#history .job-time")!.textContent).toBe("Generated in 40 s");
    expect(revoked).toEqual(["blob:preview-1", "blob:preview-2"]);
  });

  it("polls every second while the server answers fast and at the normal pace when it is slow", async () => {
    const answers: Reply[] = [
      { body: { status: "pending", progress: null, preview_seq: 0 } },
      { body: { status: "pending", progress: { step: 1, max: 5 }, preview_seq: 0 }, delayMs: 900 },
    ];
    await mount({ "POST /api/generate": { status: 202, body: { id: "job-1" } }, "GET /api/generate/job-1": () => answers.shift() ?? { body: { status: "pending" } } });
    await submitGenerate();
    expect(jobPolls().at(-1)!.ms).toBe(1000);
    await nextJobPoll();
    expect(jobPolls().at(-1)!.ms).toBe(2000);
  });

  it("keeps working when the server sends no progress fields, nonsense, or a preview that is not an image", async () => {
    const answers: Reply[] = [
      { body: { status: "pending" } },
      { body: { status: "pending", progress: { step: 30, max: 25 }, preview_seq: "7" } },
      { body: { status: "pending", progress: { step: 1, max: 2 }, preview_seq: 1 } },
      { body: { status: "done", images: [{ index: 0, url: "/api/image/job-1/0" }] } },
    ];
    await mount({
      "POST /api/generate": { status: 202, body: { id: "job-1" } },
      "GET /api/generate/job-1": () => answers.shift()!,
      "GET /api/generate/job-1/preview": { raw: "<svg/>", type: "image/svg+xml" },
    });
    await submitGenerate();
    expect(q("#history .job-step")).toBeNull();
    await nextJobPoll();
    expect(q("#history .job-step")).toBeNull();
    expect(calls.filter((c) => c.endsWith("/preview"))).toHaveLength(0);
    await nextJobPoll();
    expect(calls.filter((c) => c.endsWith("/preview"))).toHaveLength(1);
    expect(q("#history .live-preview")).toBeNull();
    expect(created).toEqual([]);
    await nextJobPoll();
    expect(q("#history img")).not.toBeNull();
  });

  it("an upscale shows only how long it has been running, no step counter", async () => {
    await mount({
      "POST /api/upscale": { status: 202, body: { id: "job-u" } },
      "GET /api/generate/job-u": { body: { status: "pending", progress: { step: 3, max: 9 }, preview_seq: 0 } },
    });
    document.querySelector<HTMLButtonElement>('.menu-item[data-tool-id="upscale"]')!.click();
    const input = q<HTMLInputElement>("#ref-input")!;
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "x.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    nowMs += 12_000;
    await nextJobPoll();
    expect(q("#history .job-step")).toBeNull();
    expect(q("#history progress")).toBeNull();
    expect(q("#history .job-elapsed")!.textContent).toBe("Running for 12 s");
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";

const INDEX = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");

interface Reply { status?: number; body: unknown; gate?: Promise<void> }
type Handler = Reply | ((body: unknown) => Reply);
interface Call { method: string; path: string; body: unknown }

function apiState(over: Record<string, unknown> = {}) {
  return {
    state: "ready",
    role: "member",
    record: null,
    vast: null,
    vast_error: null,
    agent: { state: "ready", reason: null, queue: { running: 1, pending: 2 }, gpu: { util_percent: 5, vram_total_mb: 24576, vram_used_mb: 12288 }, failsafe_alive: true, destroy: { pending: false, attempts: 0 } },
    agent_error: null,
    agent_unreachable: false,
    failed: null,
    destroy_failed: null,
    dph: 0.36,
    uptime_s: 600,
    cost_so_far: 0.06,
    progress: null,
    gpu_name: null,
    download: null,
    remaining: { idle_s: 1500, failsafe_s: 9000, hard_cap_s: 20000 },
    unknown: [],
    presets: [{ name: "zz-turbo", steps: 7 }, { name: "zz-slow", steps: 99 }],
    sizes: [{ name: "zz-square", width: 512, height: 512 }, { name: "zz-wide", width: 768, height: 512 }],
    ...over,
  };
}

let app: App | null = null;
let calls: Call[] = [];
let routes: Record<string, Handler> = {};
let nowMs = 0;

async function mount(state: Record<string, unknown> = {}, extra: Record<string, Handler> = {}): Promise<App> {
  routes = { "GET /api/me": { body: { name: "Tester", username: "tester", role: "member" } }, "GET /api/state": { body: apiState(state) }, ...extra };
  app = mountApp(document, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const h = routes[`${method} ${path}`];
      if (h === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: "not found" } }), { status: 404 });
      const r = typeof h === "function" ? h(body) : h;
      if (r.gate) await r.gate;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as typeof fetch,
    now: () => nowMs,
    setTimeout: () => 0, // timers are driven by hand in tests
    clearTimeout: () => undefined,
  });
  await app.ready;
  return app;
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

beforeEach(() => {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
  calls = [];
  nowMs = 1_000_000;
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  app?.stop();
  app = null;
});

describe("roles", () => {
  it("member does not see start/destroy/extend buttons", async () => {
    await mount({ role: "member" });
    expect(q("#btn-start")).toBeNull();
    expect(q("#btn-destroy")).toBeNull();
    expect(q("#btn-extend")).toBeNull();
    expect(q("#admin-panel")!.hidden).toBe(true);
    expect(q("#gen-form")).not.toBeNull();
  });

  it("admin sees start/destroy/extend buttons", async () => {
    await mount({ role: "admin" });
    expect(q("#btn-start")).not.toBeNull();
    expect(q("#btn-destroy")).not.toBeNull();
    expect(q("#btn-extend")).not.toBeNull();
    expect(q("#admin-panel")!.hidden).toBe(false);
  });
});

describe("generate form", () => {
  it("generate button disabled until ready", async () => {
    await mount({ state: "booting" });
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
    routes["GET /api/state"] = { body: apiState({ state: "ready" }) };
    await app!.refresh();
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });

  it("preset buttons come from the api, not constants in the page", async () => {
    await mount();
    const labels = [...document.querySelectorAll("#presets button")].map((b) => b.textContent);
    expect(labels).toEqual(["zz-turbo (7 steps)", "zz-slow (99 steps)"]);
    const sizes = [...document.querySelectorAll("#size option")].map((o) => o.textContent);
    expect(sizes).toEqual(["zz-square (512×512)", "zz-wide (768×512)"]);
    // A different api answer changes the buttons.
    routes["GET /api/state"] = { body: apiState({ presets: [{ name: "only", steps: 3 }] }) };
    await app!.refresh();
    expect([...document.querySelectorAll("#presets button")].map((b) => b.textContent)).toEqual(["only (3 steps)"]);
  });

  it("keeps the user's choices across polls", async () => {
    await mount();
    q<HTMLButtonElement>('#presets button[data-preset="zz-slow"]')!.click();
    q<HTMLSelectElement>("#size")!.value = "zz-wide";
    await app!.refresh();
    expect(q('#presets button[aria-pressed="true"]')!.getAttribute("data-preset")).toBe("zz-slow");
    expect(q<HTMLSelectElement>("#size")!.value).toBe("zz-wide");
  });

  it("submits, disables while pending, then shows images from the validated id", async () => {
    let polls = 0;
    await mount({}, {
      "POST /api/generate": { status: 202, body: { id: "job-1" } },
      "GET /api/generate/job-1": () => {
        polls += 1;
        return polls === 1
          ? { body: { status: "pending" } }
          : { body: { status: "done", images: [{ index: 0, url: "https://evil.example/x.png" }, { index: 1, url: "/api/image/job-1/1" }] } };
      },
    });
    q<HTMLButtonElement>('#presets button[data-preset="zz-slow"]')!.click();
    q<HTMLSelectElement>("#size")!.value = "zz-wide";
    q<HTMLTextAreaElement>("#prompt")!.value = "a red fox";
    q<HTMLInputElement>("#seed")!.value = "42";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/generate")[0]!.body).toEqual({ prompt: "a red fox", preset: "zz-slow", size: "zz-wide", seed: 42 });
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
    expect(q("#history")!.textContent).toContain("Generating");
    // Second poll (timers are manual, so trigger via the module's next step).
    await flush();
  });

  it("rejects an empty prompt and a bad seed without calling the api", async () => {
    await mount();
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toContain("prompt");
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    q<HTMLInputElement>("#seed")!.value = "abc";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toContain("Seed");
    expect(posts("/api/generate")).toHaveLength(0);
  });

  it("shows the api error message when submit is refused", async () => {
    await mount({}, { "POST /api/generate": { status: 400, body: { error: { code: "prompt_too_long", message: "prompt exceeds 50 characters" } } } });
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("prompt exceeds 50 characters");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });
});

describe("confirmations", () => {
  it("destroy asks for confirmation and does not call the api until confirmed", async () => {
    await mount({ role: "admin" }, { "POST /api/destroy": { body: { outcome: "destroyed", agent_reached: true } } });
    q("#btn-destroy")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(false);
    expect(posts("/api/destroy")).toHaveLength(0);
    q("#modal-cancel")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(true);
    expect(posts("/api/destroy")).toHaveLength(0);
    q("#btn-destroy")!.click();
    await flush();
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/destroy")).toHaveLength(1);
  });

  it.each([
    ["destroyed", "Destroy requested."],
    ["gone", "Destroy requested."],
    ["pending", "Destroy is queued: the instance is not visible on Vast yet; it will be destroyed as soon as it appears."],
    ["none", "No instance to destroy."],
  ])("destroy outcome %s shows its own message", async (outcome, message) => {
    await mount({ role: "admin" }, { "POST /api/destroy": { body: { outcome, agent_reached: true } } });
    q("#btn-destroy")!.click();
    await flush();
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/destroy")).toHaveLength(1);
    expect(q("#notice")!.hidden).toBe(false);
    expect(q("#notice")!.textContent).toBe(message);
  });

  it("extend confirms, then sends kind and minutes", async () => {
    await mount({ role: "admin" }, { "POST /api/extend": { body: { kind: "failsafe", deadline: 1 } } });
    q<HTMLSelectElement>("#extend-kind")!.value = "failsafe";
    q<HTMLInputElement>("#extend-minutes")!.value = "45";
    q("#btn-extend")!.click();
    await flush();
    expect(posts("/api/extend")).toHaveLength(0);
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/extend")[0]!.body).toEqual({ kind: "failsafe", minutes: 45 });
  });

  it("lists unknown instances with a destroy button each, behind a confirmation", async () => {
    await mount({ role: "admin", state: "none", unknown: [{ vast_instance_id: 11, actual_status: "running", start_date: 1, dph: 0.4 }, { vast_instance_id: 12, actual_status: null, start_date: 1, dph: 0.2 }] }, {
      "POST /api/destroy-unknown": { body: { outcome: "destroyed" } },
    });
    const buttons = document.querySelectorAll<HTMLButtonElement>("#unknown button");
    expect(buttons).toHaveLength(2);
    buttons[1]!.click();
    await flush();
    expect(posts("/api/destroy-unknown")).toHaveLength(0);
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/destroy-unknown")[0]!.body).toEqual({ vast_id: 12 });
  });
});

const GPUS = {
  gpus: [
    { name: "RTX A5000", dph: 0.25, vram_gb: 24, available: true },
    { name: "RTX 3090", dph: null, vram_gb: null, available: false },
    { name: "RTX 4090", dph: 0.45, vram_gb: 24, available: true },
  ],
};
const est = (name: string, dph: number) => ({ body: { gpu_name: name, dph, horizon_hours: 3, max_cost: dph * 3 } });
const START_ROUTES: Record<string, Handler> = {
  "GET /api/gpus": { body: GPUS },
  "GET /api/estimate?gpu=RTX%20A5000": est("RTX A5000", 0.25),
  "GET /api/estimate?gpu=RTX%204090": est("RTX 4090", 0.45),
  "POST /api/start": { body: { status: "booting", vast_instance_id: 5, estimate: { gpu_name: "RTX A5000", dph: 0.25, horizon_hours: 3, max_cost: 0.75 } } },
};
const adminNone = (extra: Record<string, Handler> = {}) => mount({ role: "admin", state: "none" }, { ...START_ROUTES, ...extra });
const openStart = async () => { q("#btn-start")!.click(); await flush(); };
const gpuSelect = () => q<HTMLSelectElement>("#start-gpu")!;
const estimateCalls = () => calls.filter((c) => c.path.startsWith("/api/estimate")).map((c) => c.path);

describe("start dialog", () => {
  it("lists the GPUs with prices, disables unavailable ones, defaults to the cheapest and shows its estimate", async () => {
    await adminNone();
    await openStart();
    expect(q("#modal")!.hidden).toBe(false);
    expect(document.querySelector('label[for="start-gpu"]')!.textContent).toBe("GPU");
    const opts = [...gpuSelect().options];
    expect(opts.map((o) => o.textContent)).toEqual(["RTX A5000 - $0.25/h", "RTX 3090 - no offers now", "RTX 4090 - $0.45/h"]);
    expect(opts.map((o) => o.disabled)).toEqual([false, true, false]);
    expect(gpuSelect().value).toBe("RTX A5000");
    expect(estimateCalls()).toEqual(["/api/estimate?gpu=RTX%20A5000"]);
    const text = q("#modal")!.textContent!;
    expect(text).toContain("$0.25/hour");
    expect(text).toContain("(RTX A5000)");
    expect(text).toContain("3 hours");
    expect(text).toContain("$0.75");
    expect(text).toContain("covers the failsafe time only");
    expect(text).toContain("up to the hard cap");
    expect(text).toContain("Disk storage is billed separately, per hour");
    expect(posts("/api/start")).toHaveLength(0);
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(false);
  });

  it("uses the remembered GPU when it is still available", async () => {
    window.localStorage.setItem("vast-comfy.gpu", "RTX 4090");
    await adminNone();
    await openStart();
    expect(gpuSelect().value).toBe("RTX 4090");
    expect(estimateCalls()).toEqual(["/api/estimate?gpu=RTX%204090"]);
  });

  it.each(["RTX 3090", "GTX 1080", "<b>x</b>", ""])("falls back to the cheapest when the remembered value %j is unavailable or unlisted", async (stored) => {
    window.localStorage.setItem("vast-comfy.gpu", stored);
    await adminNone();
    await openStart();
    expect(gpuSelect().value).toBe("RTX A5000");
  });

  it("works when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await adminNone();
    await openStart();
    expect(gpuSelect().value).toBe("RTX A5000");
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")).toHaveLength(1);
    expect(q("#modal")!.hidden).toBe(true);
    expect(q("#notice")!.hidden).toBe(false);
  });

  it("refetches the estimate with the encoded name when the selection changes", async () => {
    await adminNone();
    await openStart();
    gpuSelect().value = "RTX 4090";
    gpuSelect().dispatchEvent(new Event("change"));
    await flush();
    expect(estimateCalls()).toEqual(["/api/estimate?gpu=RTX%20A5000", "/api/estimate?gpu=RTX%204090"]);
    expect(q("#modal")!.textContent).toContain("$0.45/hour");
    expect(q("#modal")!.textContent).toContain("$1.35");
  });

  it("ignores a stale estimate answer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await adminNone();
    routes["GET /api/estimate?gpu=RTX%20A5000"] = { ...est("RTX A5000", 0.25), gate };
    q("#btn-start")!.click();
    await flush();
    // The A5000 estimate is still pending: switch to the 4090, which answers at once.
    gpuSelect().value = "RTX 4090";
    gpuSelect().dispatchEvent(new Event("change"));
    await flush();
    expect(q("#modal")!.textContent).toContain("$0.45/hour");
    release();
    await flush();
    expect(q("#modal")!.textContent).toContain("$0.45/hour");
    expect(q("#modal")!.textContent).not.toContain("$0.25/hour");
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")[0]!.body).toEqual({ confirm: true, gpu: "RTX 4090" });
  });

  it("confirm posts the chosen GPU, remembers it and shows the GPU the server returned", async () => {
    await adminNone();
    await openStart();
    gpuSelect().value = "RTX 4090";
    gpuSelect().dispatchEvent(new Event("change"));
    await flush();
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")).toEqual([{ method: "POST", path: "/api/start", body: { confirm: true, gpu: "RTX 4090" } }]);
    expect(window.localStorage.getItem("vast-comfy.gpu")).toBe("RTX 4090");
    expect(q("#modal")!.hidden).toBe(true);
    // The shared attempt rented an A5000: the notice names that, not the dropdown value.
    expect(q("#notice")!.textContent).toContain("RTX A5000");
    expect(q("#notice")!.textContent).not.toContain("4090");
  });

  it("double clicking confirm sends one request", async () => {
    await adminNone();
    await openStart();
    q("#modal-ok")!.click();
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")).toHaveLength(1);
  });

  it("cannot be cancelled while the start request is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await adminNone({ "POST /api/start": { ...(START_ROUTES["POST /api/start"] as Reply), gate } });
    await openStart();
    q("#modal-ok")!.click();
    await flush();
    q("#modal-cancel")!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(q("#modal")!.hidden).toBe(false);
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(true);
    release();
    await flush();
    expect(q("#modal")!.hidden).toBe(true);
    expect(posts("/api/start")).toHaveLength(1);
  });

  it("a failed start shows message and reason in the dialog, keeps it open and re-enables confirm", async () => {
    await adminNone({ "POST /api/start": { status: 502, body: { error: { code: "start_failed", message: "the Tailscale auth key is missing or empty on the server", reason: "ts_key_missing" } } } });
    await openStart();
    q("#modal-ok")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(false);
    const alert = q('#modal-body [role="alert"]')!;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain("the Tailscale auth key is missing or empty on the server");
    expect(alert.textContent).toContain("ts_key_missing");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(false);
    expect(gpuSelect().disabled).toBe(false);
    expect(q("#banner")!.textContent).toBe("the Tailscale auth key is missing or empty on the server");
    expect(window.localStorage.getItem("vast-comfy.gpu")).toBeNull();
    // A retry works.
    routes["POST /api/start"] = START_ROUTES["POST /api/start"]!;
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")).toHaveLength(2);
    expect(q("#modal")!.hidden).toBe(true);
  });

  it("a failing GPU list shows the error inside the dialog and cannot start", async () => {
    await adminNone({ "GET /api/gpus": { status: 503, body: { error: { code: "no_gpu_configured", message: "no GPU model is configured on the server" } } } });
    await openStart();
    expect(q("#modal")!.hidden).toBe(false);
    expect(q('#modal-body [role="alert"]')!.textContent).toContain("no GPU model is configured on the server");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(true);
    expect(estimateCalls()).toHaveLength(0);
    q("#modal-cancel")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(true);
  });

  it("a failing estimate shows the error in the dialog and disables confirm", async () => {
    await adminNone({ "GET /api/estimate?gpu=RTX%20A5000": { status: 409, body: { error: { code: "no_offers", message: "no Vast offer matches for this GPU model right now" } } } });
    await openStart();
    expect(q("#modal")!.hidden).toBe(false);
    expect(q('#modal-body [role="alert"]')!.textContent).toContain("no Vast offer matches");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(true);
    expect(posts("/api/start")).toHaveLength(0);
  });

  it("with no GPU available the select is disabled with a message and confirm is off", async () => {
    await adminNone({ "GET /api/gpus": { body: { gpus: [{ name: "RTX 3090", dph: null, vram_gb: null, available: false }] } } });
    await openStart();
    expect(gpuSelect().disabled).toBe(true);
    expect(q("#modal")!.textContent).toContain("No GPU model has offers right now");
    expect(q<HTMLButtonElement>("#modal-ok")!.disabled).toBe(true);
    expect(estimateCalls()).toHaveLength(0);
  });

  it("a hostile GPU name stays inert", async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    await adminNone({
      "GET /api/gpus": { body: { gpus: [{ name: evil, dph: 0.2, vram_gb: 24, available: true }] } },
      [`GET /api/estimate?gpu=${encodeURIComponent(evil)}`]: est(evil, 0.2),
      "POST /api/start": { body: { status: "booting", vast_instance_id: 1, estimate: { gpu_name: evil, dph: 0.2, horizon_hours: 3, max_cost: 0.6 } } },
    });
    await openStart();
    expect(gpuSelect().options[0]!.textContent).toContain(evil);
    expect(gpuSelect().value).toBe(evil);
    expect(q("#modal")!.textContent).toContain(evil);
    q("#modal-ok")!.click();
    await flush();
    expect(q("#notice")!.textContent).toContain(evil);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });

  it("cancel closes without starting", async () => {
    await adminNone();
    await openStart();
    q("#modal-cancel")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(true);
    expect(posts("/api/start")).toHaveLength(0);
  });

  it("a member has no start button and never loads the GPU list", async () => {
    await mount({ role: "member", state: "none" }, START_ROUTES);
    expect(q("#btn-start")).toBeNull();
    expect(calls.some((c) => c.path === "/api/gpus")).toBe(false);
  });
});

describe("failures", () => {
  it("shows destroy_failed prominently", async () => {
    await mount({ state: "destroy_failed", destroy_failed: { error: "Vast said no" } });
    const box = q("#alert-destroy-failed")!;
    expect(box.hidden).toBe(false);
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.textContent).toContain("Could not destroy");
    expect(box.textContent).toContain("Vast said no");
    expect(q("#state-line")!.dataset["tone"]).toBe("bad");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
  });

  it("shows failed with its reason", async () => {
    await mount({ state: "failed", failed: { reason: "out of disk" } });
    expect(q("#alert-failed")!.hidden).toBe(false);
    expect(q("#alert-failed")!.textContent).toContain("out of disk");
    expect(q("#state-line")!.textContent).toBe("Failed");
  });

  it("warns when the agent is unreachable", async () => {
    await mount({ state: "ready", agent: null, agent_unreachable: true });
    expect(q("#alert-agent")!.hidden).toBe(false);
    expect(q("#alert-agent")!.getAttribute("role")).toBe("alert");
  });

  it("hides the failure boxes when all is well", async () => {
    await mount();
    for (const id of ["#alert-failed", "#alert-destroy-failed", "#alert-agent", "#banner"]) expect(q(id)!.hidden).toBe(true);
  });

  it("shows a banner when the status request fails and clears it on recovery", async () => {
    await mount();
    routes["GET /api/state"] = { status: 500, body: { error: { code: "internal_error", message: "internal error" } } };
    await app!.refresh();
    expect(q("#banner")!.textContent).toBe("internal error");
    routes["GET /api/state"] = { body: apiState() };
    await app!.refresh();
    expect(q("#banner")!.hidden).toBe(true);
  });
});

describe("status card", () => {
  it("shows download progress", async () => {
    await mount({ state: "downloading", progress: { phase: "models", file: "model.safetensors", bytes_done: 30, bytes_total: 100 } });
    expect(q("#state-line")!.textContent).toBe("Downloading models: 30%");
    expect(q("#progress-box")!.hidden).toBe(false);
    expect(q<HTMLProgressElement>("#progress")!.value).toBe(30);
    expect(q("#progress-file")!.textContent).toBe("model.safetensors");
  });

  it("shows the GPU name from the state", async () => {
    await mount({ gpu_name: "RTX 4090" });
    expect(q("#f-gpu")!.textContent).toBe("RTX 4090");
    expect(q("#f-price")!.textContent).toBe("$0.36/hour");
    await mount({ gpu_name: null });
    expect(q("#f-gpu")!.textContent).toBe("—");
  });

  it("renders a hostile GPU name in the status card as text", async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    await mount({ gpu_name: evil });
    expect(q("#f-gpu")!.textContent).toBe(evil);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  it("shows uptime, cost, queue, vram and remaining time", async () => {
    await mount();
    expect(q("#f-uptime")!.textContent).toBe("10m 00s");
    expect(q("#f-cost")!.textContent).toBe("$0.06");
    expect(q("#f-queue")!.textContent).toBe("1 running, 2 waiting");
    expect(q("#f-vram")!.textContent).toBe("12.0 / 24.0 GB");
    expect(q("#f-idle")!.textContent).toBe("25m 00s");
    expect(q("#f-failsafe")!.textContent).toBe("2h 30m");
  });

  it("refetches when the tab becomes visible again", async () => {
    await mount();
    const before = calls.length;
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(calls.length).toBeGreaterThan(before);
  });
});

describe("overall download progress", () => {
  const dl = (over: Record<string, unknown> = {}) => ({
    state: "downloading",
    progress: { phase: "models", file: "a.safetensors", bytes_done: 500, bytes_total: 1000 },
    download: { files_total: 3, files_done: 1, bytes_done: 2_100_000_000, bytes_total: 14_600_000_000, current_file: "a.safetensors", ...over },
  });
  const tick = async (state: Record<string, unknown>, at: number) => {
    nowMs = at;
    routes["GET /api/state"] = { body: apiState(state) };
    await app!.refresh();
  };

  it("shows one overall bar, GB text, file n of m and the per-file name; no speed before two samples", async () => {
    await mount(dl());
    expect(q("#state-line")!.textContent).toBe("Downloading models: 14%");
    expect(q<HTMLProgressElement>("#progress")!.value).toBe(14);
    expect(q("#progress-text")!.hidden).toBe(false);
    expect(q("#progress-text")!.textContent).toBe("2.1 / 14.6 GB (14%) - file 2 of 3");
    expect(q("#progress-file")!.textContent).toBe("a.safetensors");
  });

  it("adds speed and ETA after a second sample", async () => {
    await mount(dl());
    await tick(dl({ bytes_done: 2_100_000_000 + 380_000_000 }), nowMs + 10_000);
    const text = q("#progress-text")!.textContent!;
    expect(text).toBe("2.5 / 14.6 GB (16%) - file 2 of 3 - 38 MB/s - about 5 min left");
    expect(text).not.toMatch(/NaN|Infinity/);
  });

  it("shows no speed when nothing moved, and never NaN", async () => {
    await mount(dl());
    await tick(dl(), nowMs + 10_000);
    expect(q("#progress-text")!.textContent).toBe("2.1 / 14.6 GB (14%) - file 2 of 3");
  });

  it("does not jump back when the current file changes", async () => {
    await mount(dl({ files_done: 0, bytes_done: 4_000_000_000, current_file: "a" }));
    const before = q<HTMLProgressElement>("#progress")!.value;
    await tick(dl({ files_done: 1, bytes_done: 4_600_000_000, current_file: "b" }), nowMs + 10_000);
    expect(q<HTMLProgressElement>("#progress")!.value).toBeGreaterThanOrEqual(before);
    expect(q("#progress-text")!.textContent).toContain("file 2 of 3");
    expect(q("#progress-text")!.textContent).toContain("60 MB/s");
  });

  it("drops the speed when the counter goes down", async () => {
    await mount(dl());
    await tick(dl({ bytes_done: 3_000_000_000 }), nowMs + 10_000);
    expect(q("#progress-text")!.textContent).toContain("MB/s");
    await tick(dl({ bytes_done: 1_000_000_000 }), nowMs + 10_000);
    expect(q("#progress-text")!.textContent).not.toContain("MB/s");
  });

  it("falls back to the per-file bar when the server sends no overall download", async () => {
    await mount({ state: "downloading", progress: { phase: "models", file: "m.safetensors", bytes_done: 30, bytes_total: 100 } });
    expect(q("#progress-text")!.hidden).toBe(true);
    expect(q<HTMLProgressElement>("#progress")!.value).toBe(30);
  });

  it("renders a hostile file name as text", async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    await mount(dl({ current_file: evil }));
    await tick({ ...dl({ current_file: evil }), progress: null }, nowMs + 1000);
    expect(q("#progress-file")!.textContent).toBe(evil);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("text from the api is inert", () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  it("renders failure text, preset names, sizes and unknown ids as text", async () => {
    await mount({
      role: "admin",
      state: "failed",
      failed: { reason: evil },
      destroy_failed: { error: evil },
      presets: [{ name: evil, steps: 5 }],
      sizes: [{ name: evil, width: 1, height: 1 }],
      progress: { phase: "models", file: evil, bytes_done: 1, bytes_total: 2 },
    });
    expect(q("#failed-reason")!.textContent).toBe(evil);
    expect(q("#presets button")!.textContent).toContain(evil);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });

  it("renders error banners and job messages as text", async () => {
    await mount({}, {
      "POST /api/generate": { status: 202, body: { id: "j2" } },
      "GET /api/generate/j2": { body: { status: "failed", message: evil } },
    });
    routes["GET /api/state"] = { status: 500, body: { error: { code: "x", message: evil } } };
    await app!.refresh();
    expect(q("#banner")!.textContent).toBe(evil);
    routes["GET /api/state"] = { body: apiState() };
    await app!.refresh();
    q<HTMLTextAreaElement>("#prompt")!.value = evil;
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    await flush();
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(q("#history")!.textContent).toContain(evil);
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });

  it("builds image urls from the job id and a numeric index only", async () => {
    // The poll timer is manual: drive the job poll by returning done on the first request.
    await mount({}, {
      "POST /api/generate": { status: 202, body: { id: "job-9" } },
      "GET /api/generate/job-9": { body: { status: "done", images: [{ index: 0, url: "https://evil.example/x.png" }, { index: "../1", url: "/x" }, { index: 3 }] } },
    });
    q<HTMLTextAreaElement>("#prompt")!.value = "fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    const imgs = [...document.querySelectorAll<HTMLImageElement>("#history img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["/api/image/job-9/0", "/api/image/job-9/3"]);
    const links = [...document.querySelectorAll<HTMLAnchorElement>("#history a.dl")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/api/image/job-9/0", "/api/image/job-9/3"]);
    expect(links[0]!.hasAttribute("download")).toBe(true);
    // The button is usable again once the job is done.
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });

  it("refuses an unusable job id from the server", async () => {
    await mount({}, { "POST /api/generate": { status: 202, body: { id: "../../etc" } } });
    q<HTMLTextAreaElement>("#prompt")!.value = "fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toContain("unusable");
    expect(calls.filter((c) => c.path.startsWith("/api/generate/"))).toHaveLength(0);
  });
});

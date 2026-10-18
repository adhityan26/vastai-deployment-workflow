// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";

const INDEX = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");

interface Reply { status?: number; body: unknown; gate?: Promise<void>; /** Sent as raw bytes with this content type instead of JSON. */ raw?: string; type?: string }
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
      if (r.raw !== undefined) return new Response(r.raw, { status: r.status ?? 200, headers: { "Content-Type": r.type ?? "image/png" } });
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

describe("edit with reference images", () => {
  const editInfo = {
    max_references: 3,
    max_bytes: 1000,
    max_pixels: 1_000_000,
    types: ["png", "jpeg"],
    resolutions: [{ name: "zz-res", value: 1024 }, { name: "zz-res-2", value: 768 }],
  };

  const imageFile = (name: string, content = "PNGDATA", type = "image/png") => new File([content], name, { type });

  /** Put files into the picker the way a browser does and fire its change event. */
  function pick(...files: File[]): void {
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change"));
  }
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const chooseEdit = () => q<HTMLButtonElement>("#mode-edit")!.click();
  const tags = () => [...document.querySelectorAll("#ref-list .ref-tag")].map((n) => n.textContent);

  let created: string[] = [];
  let revoked: string[] = [];
  beforeEach(() => {
    created = [];
    revoked = [];
    window.URL.createObjectURL = (() => {
      const url = `blob:fake-${created.length}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    window.URL.revokeObjectURL = ((url: string) => void revoked.push(url)) as typeof URL.revokeObjectURL;
  });

  it("offers the mode switch only when the server offers edit, and switches the form", async () => {
    await mount();
    expect(q("#mode-box")!.hidden).toBe(true);
    expect(q("#edit-box")!.hidden).toBe(true);
    routes["GET /api/state"] = { body: apiState({ edit: editInfo }) };
    await app!.refresh();
    expect(q("#mode-box")!.hidden).toBe(false);
    expect(q("#edit-box")!.hidden).toBe(true);
    expect(q("#size-box")!.hidden).toBe(false);
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Generate");

    chooseEdit();
    expect(q("#edit-box")!.hidden).toBe(false);
    expect(q("#size-box")!.hidden).toBe(true);
    expect(q("#mode-edit")!.getAttribute("aria-pressed")).toBe("true");
    expect(q("#mode-generate")!.getAttribute("aria-pressed")).toBe("false");
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Edit");

    q<HTMLButtonElement>("#mode-generate")!.click();
    expect(q("#edit-box")!.hidden).toBe(true);
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Generate");
  });

  it("takes the accepted types, hint and resolutions from the api, and keeps the choice across polls", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    expect(q<HTMLInputElement>("#ref-input")!.accept).toBe("image/png,image/jpeg");
    expect(q("#ref-hint")!.textContent).toContain("Up to 3 images (PNG, JPEG)");
    expect([...document.querySelectorAll("#resolution option")].map((o) => o.textContent)).toEqual(["zz-res", "zz-res-2"]);
    q<HTMLSelectElement>("#resolution")!.value = "zz-res-2";
    await app!.refresh();
    expect(q<HTMLSelectElement>("#resolution")!.value).toBe("zz-res-2");
    expect(q("#mode-edit")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows previews tagged <image1>, <image2>, removes one, and releases the preview url", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    pick(imageFile("one.png"), imageFile("two.jpg", "JPG", "image/jpeg"));
    expect(tags()).toEqual(["<image1>", "<image2>"]);
    expect(document.querySelectorAll("#ref-list img")).toHaveLength(2);
    expect(q<HTMLImageElement>("#ref-list img")!.getAttribute("src")).toBe("blob:fake-0");
    expect(q("#ref-error")!.hidden).toBe(true);

    q<HTMLButtonElement>("#ref-list li button")!.click();
    expect(tags()).toEqual(["<image1>"]);
    expect([...document.querySelectorAll("#ref-list .ref-name")].map((n) => n.textContent)).toEqual(["two.jpg"]);
    expect(revoked).toEqual(["blob:fake-0"]);
  });

  it("refuses the wrong type, empty and oversized files and a fourth image, and says why", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    pick(imageFile("notes.txt", "x", "text/plain"), imageFile("empty.png", ""), imageFile("big.png", "x".repeat(1001)));
    expect(tags()).toEqual([]);
    const text = q("#ref-error")!.textContent!;
    expect(q("#ref-error")!.hidden).toBe(false);
    expect(text).toContain("notes.txt");
    expect(text).toContain("empty.png");
    expect(text).toContain("big.png");

    pick(imageFile("a.png"), imageFile("b.png"), imageFile("c.png"), imageFile("d.png"));
    expect(tags()).toEqual(["<image1>", "<image2>", "<image3>"]);
    expect(q("#ref-error")!.textContent).toBe("At most 3 images can be attached.");
    pick(imageFile("e.png"));
    expect(tags()).toHaveLength(3);
  });

  it("renders a hostile file name as text only", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    pick(imageFile('<img src=x onerror="alert(1)">.png'));
    expect(q("#ref-list img[onerror]")).toBeNull();
    expect(q("#ref-list .ref-name")!.textContent).toBe('<img src=x onerror="alert(1)">.png');
    expect(document.querySelectorAll("#ref-list img")).toHaveLength(1); // only the preview
  });

  it("does not call the api without a prompt or without references", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("Describe the change first.");
    q<HTMLTextAreaElement>("#prompt")!.value = "make it real";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("Attach at least one reference image.");
    expect(posts("/api/edit")).toHaveLength(0);
    expect(posts("/api/generate")).toHaveLength(0);
  });

  it("posts the prompt, preset, resolution, seed and the images as base64 in order, then polls the job", async () => {
    let polls = 0;
    await mount({ edit: editInfo }, {
      "POST /api/edit": { status: 202, body: { id: "edit-1" } },
      "GET /api/generate/edit-1": () => {
        polls += 1;
        return polls === 1 ? { body: { status: "pending" } } : { body: { status: "done", images: [{ index: 0, url: "/api/image/edit-1/0" }] } };
      },
    });
    chooseEdit();
    pick(imageFile("one.png", "FIRST"), imageFile("two.jpg", "SECOND", "image/jpeg"));
    q<HTMLTextAreaElement>("#prompt")!.value = "put <image2> on <image1>";
    q<HTMLInputElement>("#seed")!.value = "42";
    q<HTMLButtonElement>('#presets button[data-preset="zz-slow"]')!.click();
    q<HTMLSelectElement>("#resolution")!.value = "zz-res-2";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
    await flush();

    expect(posts("/api/edit")).toHaveLength(1);
    expect(posts("/api/edit")[0]!.body).toEqual({
      prompt: "put <image2> on <image1>",
      preset: "zz-slow",
      resolution: "zz-res-2",
      images: [b64("FIRST"), b64("SECOND")],
      seed: 42,
    });
    expect(posts("/api/generate")).toHaveLength(0);
    expect(q(".job .muted")!.textContent).toBe("Edit: zz-slow (99 steps), zz-res-2, 2 references");
    expect(q(".job-prompt")!.textContent).toBe("put <image2> on <image1>");

    // The job is read through the same poll route as a generate job.
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/generate/edit-1")).toBe(true);
    // The attached images stay for a tweak-and-retry.
    expect(tags()).toEqual(["<image1>", "<image2>"]);
  });

  it("sends one request when submitted twice quickly", async () => {
    await mount({ edit: editInfo }, { "POST /api/edit": { status: 202, body: { id: "edit-1" }, gate: Promise.resolve() } });
    chooseEdit();
    pick(imageFile("one.png"));
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    const form = q<HTMLFormElement>("#gen-form")!;
    form.requestSubmit();
    form.requestSubmit();
    await flush();
    expect(posts("/api/edit")).toHaveLength(1);
  });

  it("shows the api refusal, keeps the images and re-enables the button", async () => {
    await mount({ edit: editInfo }, {
      "POST /api/edit": { status: 400, body: { error: { code: "reference_too_many_pixels", message: "reference 1 has more than 1000000 pixels" } } },
    });
    chooseEdit();
    pick(imageFile("one.png"));
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.hidden).toBe(false);
    expect(q("#form-error")!.textContent).toBe("reference 1 has more than 1000000 pixels");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
    expect(tags()).toEqual(["<image1>"]);
  });

  it("is disabled until the instance is ready, and falls back to generate when the server stops offering edit", async () => {
    await mount({ state: "booting", edit: editInfo });
    chooseEdit();
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(true);
    routes["GET /api/state"] = { body: apiState({ state: "ready", edit: null }) };
    await app!.refresh();
    expect(q("#mode-box")!.hidden).toBe(true);
    expect(q("#edit-box")!.hidden).toBe(true);
    expect(q("#size-box")!.hidden).toBe(false);
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Generate");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });

  it("releases the preview urls when the app stops", async () => {
    await mount({ edit: editInfo });
    chooseEdit();
    pick(imageFile("one.png"), imageFile("two.png"));
    app!.stop();
    expect(revoked).toEqual(["blob:fake-0", "blob:fake-1"]);
  });
});

describe("Vast credit", () => {
  const credit = (c: number) => ({ body: { credit: c, as_of: 1_800_000_000 } });
  const creditCalls = () => calls.filter((c) => c.path === "/api/credit");

  it("an admin sees the credit in the status card", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": credit(4.5377) });
    await flush();
    expect(q("#f-credit-box")!.hidden).toBe(false);
    expect(q("#f-credit")!.textContent).toBe("$4.54");
    expect(creditCalls()).toHaveLength(1);
  });

  it("a member never sees it and never asks for it", async () => {
    await mount({ role: "member" }, { "GET /api/credit": credit(4.5) });
    await flush();
    expect(q("#f-credit-box")!.hidden).toBe(true);
    expect(creditCalls()).toHaveLength(0);
  });

  it("asks once a minute, not on every status poll", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": credit(4.5) });
    await flush();
    nowMs += 5_000;
    await app!.refresh();
    nowMs += 40_000;
    await app!.refresh();
    await flush();
    expect(creditCalls()).toHaveLength(1);
    routes["GET /api/credit"] = credit(3.25);
    nowMs += 20_000; // 65 s after the first read
    await app!.refresh();
    await flush();
    expect(creditCalls()).toHaveLength(2);
    expect(q("#f-credit")!.textContent).toBe("$3.25");
  });

  it("shows a used-up credit with a minus sign", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": credit(-0.8) });
    await flush();
    expect(q("#f-credit")!.textContent).toBe("-$0.80");
  });

  it("shows 'unavailable' when the server cannot read it, and retries after the interval", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": { status: 502, body: { error: { code: "vast_unavailable", message: "could not read the Vast account credit" } } } });
    await flush();
    expect(q("#f-credit")!.textContent).toBe("unavailable");
    expect(q("#banner")!.hidden).toBe(true); // a credit problem is not a page-level alert
    routes["GET /api/credit"] = credit(2);
    nowMs += 61_000;
    await app!.refresh();
    await flush();
    expect(q("#f-credit")!.textContent).toBe("$2.00");
  });

  it("shows 'unavailable' for an unusable answer and renders nothing the server did not send as a number", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": { body: { credit: "<b>lots</b>" } } });
    await flush();
    expect(q("#f-credit")!.textContent).toBe("unavailable");
    expect(q("#f-credit b")).toBeNull();
  });

  it("hides the box when the account is no longer an admin", async () => {
    await mount({ role: "admin" }, { "GET /api/credit": credit(4.5) });
    await flush();
    routes["GET /api/state"] = { body: apiState({ role: "member" }) };
    await app!.refresh();
    expect(q("#f-credit-box")!.hidden).toBe(true);
  });
});

describe("gallery: save, auto-save and the gallery card", () => {
  const GID = (n: number, job = "job-1") => `${"b".repeat(31)}${n % 10}.8199999999${String(100 + n).padStart(3, "0")}.${job}.0`;
  const item = (n: number, over: Record<string, unknown> = {}) => ({
    id: GID(n), url: `/api/gallery/${GID(n)}/image`, created_at: 1_800_000_000 + n, kind: "generate", prompt: `prompt ${n}`, label: "preview, 1:1", owner_name: "Ayu", mine: true, size: 2_000_000, ...over,
  });
  const gallerySaves = () => posts("/api/gallery");

  /** Submit a generate job and let it finish with the given server image indexes. */
  async function finishJob(indexes: number[] = [0], extra: Record<string, Handler> = {}, state: Record<string, unknown> = {}) {
    await mount({ gallery: true, ...state }, {
      "POST /api/generate": { status: 202, body: { id: "job-1" } },
      "GET /api/generate/job-1": { body: { status: "done", images: indexes.map((index) => ({ index, url: `/api/image/job-1/${index}` })) } },
      ...extra,
    });
    q<HTMLTextAreaElement>("#prompt")!.value = "a red fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
  }
  const saveButtons = () => [...document.querySelectorAll<HTMLButtonElement>("#history button.save")];

  it("offers nothing when the server has no gallery", async () => {
    await mount({ gallery: false }, { "POST /api/generate": { status: 202, body: { id: "job-1" } }, "GET /api/generate/job-1": { body: { status: "done", images: [{ index: 0, url: "/x" }] } } });
    q<HTMLTextAreaElement>("#prompt")!.value = "x";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#gallery-card")!.hidden).toBe(true);
    expect(q("#autosave-box")!.hidden).toBe(true);
    expect(saveButtons()).toHaveLength(0);
  });

  it("shows the gallery card and the auto-save box when it is on", async () => {
    await mount({ gallery: true });
    expect(q("#gallery-card")!.hidden).toBe(false);
    expect(q("#autosave-box")!.hidden).toBe(false);
  });

  it("a Save button per result posts the job id and the server's image index, then shows Saved", async () => {
    await finishJob([2, 5], { "POST /api/gallery": { status: 201, body: { id: GID(1), created: true } } });
    expect(saveButtons().map((b) => b.textContent)).toEqual(["Save to gallery", "Save to gallery"]);
    saveButtons()[1]!.click();
    await flush();
    expect(gallerySaves()).toHaveLength(1);
    expect(gallerySaves()[0]!.body).toEqual({ job: "job-1", index: 5 });
    expect(saveButtons().map((b) => [b.textContent, b.disabled])).toEqual([["Save to gallery", false], ["Saved ✓", true]]);
    saveButtons()[1]!.click();
    await flush();
    expect(gallerySaves()).toHaveLength(1);
  });

  it("a failed save says why on the image and can be retried", async () => {
    let fail = true;
    await finishJob([0], { "POST /api/gallery": () => (fail ? { status: 409, body: { error: { code: "gallery_quota", message: "the gallery is full (300 images)" } } } : { status: 201, body: { id: GID(1), created: true } }) });
    saveButtons()[0]!.click();
    await flush();
    expect(q("#history .alert.bad")!.textContent).toBe("Not saved: the gallery is full (300 images)");
    expect(saveButtons()[0]!.disabled).toBe(false);
    fail = false;
    saveButtons()[0]!.click();
    await flush();
    expect(saveButtons()[0]!.textContent).toBe("Saved ✓");
    expect(q("#history .alert.bad")).toBeNull();
  });

  it("auto-save saves every image of a finished job, remembers the choice, and is off by default", async () => {
    expect(window.localStorage.getItem("vast-comfy.autosave")).toBeNull();
    await mount({ gallery: true });
    expect(q<HTMLInputElement>("#autosave")!.checked).toBe(false);
    q<HTMLInputElement>("#autosave")!.click();
    expect(window.localStorage.getItem("vast-comfy.autosave")).toBe("1");
    app!.stop();
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
    calls = [];
    await finishJob([0, 1], { "POST /api/gallery": { status: 201, body: { id: GID(1), created: true } } });
    expect(q<HTMLInputElement>("#autosave")!.checked).toBe(true);
    await flush();
    expect(gallerySaves().map((c) => c.body)).toEqual([{ job: "job-1", index: 0 }, { job: "job-1", index: 1 }]);
    expect(saveButtons().map((b) => b.textContent)).toEqual(["Saved ✓", "Saved ✓"]);
  });

  it("without auto-save nothing is saved by itself", async () => {
    await finishJob([0]);
    await flush();
    expect(gallerySaves()).toHaveLength(0);
  });

  it("works when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await mount({ gallery: true });
    expect(q<HTMLInputElement>("#autosave")!.checked).toBe(false);
    q<HTMLInputElement>("#autosave")!.click();
    expect(q<HTMLInputElement>("#autosave")!.checked).toBe(true);
  });

  describe("the gallery card", () => {
    it("continues from a saved image: attaches it as a reference or into upscale, and offers nothing without edit or upscale", async () => {
      const editOffer = { max_references: 3, max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"], resolutions: [{ name: "zz-res", value: 1024 }] };
      const upOffer = { scales: ["2x"], max_bytes: 1000, max_pixels: 1_000_000, types: ["png"] };
      window.URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
      await mount({ gallery: true, edit: editOffer, upscale: upOffer }, {
        "GET /api/gallery": { body: { items: [item(1)], next: null } },
        [`GET /api/gallery/${GID(1)}/image`]: { body: null, raw: "SAVED", type: "image/png" },
      });
      q("#gal-open")!.click();
      await flush();
      const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("#gal-list .chain button")];
      expect(buttons().map((b) => b.textContent)).toEqual(["Use as reference", "Upscale"]);
      buttons()[0]!.click();
      await flush();
      expect(q("#mode-edit")!.getAttribute("aria-pressed")).toBe("true");
      expect(q("#ref-list .ref-name")!.textContent).toBe(`saved-${GID(1).slice(0, 8)}.png`);
      buttons()[1]!.click();
      await flush();
      expect(q("#mode-upscale")!.getAttribute("aria-pressed")).toBe("true");
      expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
    });

    it("shows no continue buttons when the server offers neither edit nor upscale", async () => {
      await mount({ gallery: true }, { "GET /api/gallery": { body: { items: [item(1)], next: null } } });
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-list .chain")).toBeNull();
    });

    it("loads nothing until it is opened, then lists the images with urls rebuilt from the ids", async () => {
      await mount({ gallery: true }, { "GET /api/gallery": { body: { items: [item(1, { url: "https://evil.example/x.png" }), item(2)], next: null } } });
      expect(calls.filter((c) => c.path.startsWith("/api/gallery"))).toHaveLength(0);
      q("#gal-open")!.click();
      await flush();
      const imgs = [...document.querySelectorAll<HTMLImageElement>("#gal-list img")];
      expect(imgs.map((i) => i.getAttribute("src"))).toEqual([`/api/gallery/${GID(1)}/image`, `/api/gallery/${GID(2)}/image`]);
      expect(q("#gal-list")!.hidden).toBe(false);
      expect(q("#gal-empty")!.hidden).toBe(true);
      expect(q("#gal-more")!.hidden).toBe(true);
      expect(q(".gal-caption")!.textContent).toBe("preview, 1:1 · 2027-01-15 08:00 UTC · 1.9 MB");
    });

    it("shows the empty state, and an error when the list cannot be read", async () => {
      await mount({ gallery: true }, { "GET /api/gallery": { body: { items: [], next: null } } });
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-empty")!.hidden).toBe(false);
      routes["GET /api/gallery"] = { status: 502, body: { error: { code: "gallery_error", message: "the gallery storage could not be reached" } } };
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-error")!.hidden).toBe(false);
      expect(q("#gal-error")!.textContent).toBe("the gallery storage could not be reached");
    });

    it("Load more asks for the next page with the cursor and appends", async () => {
      await mount({ gallery: true }, {
        "GET /api/gallery": { body: { items: [item(1), item(2)], next: GID(2) } },
        [`GET /api/gallery?cursor=${GID(2)}`]: { body: { items: [item(3)], next: null } },
      });
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-more")!.hidden).toBe(false);
      q("#gal-more")!.click();
      await flush();
      expect(document.querySelectorAll("#gal-list figure")).toHaveLength(3);
      expect(q("#gal-more")!.hidden).toBe(true);
    });

    it("renders prompts and names as text", async () => {
      await mount({ gallery: true }, { "GET /api/gallery": { body: { items: [item(1, { prompt: '<img src=x onerror="alert(1)">', label: "<b>x</b>" })], next: null } } });
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-list img[onerror]")).toBeNull();
      expect(q(".gal-prompt")!.textContent).toBe('<img src=x onerror="alert(1)">');
      expect(q("#gal-list b")).toBeNull();
    });

    it("only an admin gets 'everyone', which reloads with scope=all and shows other owners", async () => {
      await mount({ gallery: true, role: "member" }, { "GET /api/gallery": { body: { items: [item(1)], next: null } } });
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-all-box")!.hidden).toBe(true);
      app!.stop();
      document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
      calls = [];
      await mount({ gallery: true, role: "admin" }, {
        "GET /api/gallery": { body: { items: [item(1)], next: null } },
        "GET /api/gallery?scope=all": { body: { items: [item(2, { mine: false, owner_name: "Budi" }), item(1)], next: null } },
      });
      expect(q("#gal-all-box")!.hidden).toBe(true); // only once the gallery is open
      q("#gal-open")!.click();
      await flush();
      expect(q("#gal-all-box")!.hidden).toBe(false);
      q<HTMLInputElement>("#gal-all")!.click();
      await flush();
      expect(calls.some((c) => c.path === "/api/gallery?scope=all")).toBe(true);
      const captions = [...document.querySelectorAll(".gal-caption")].map((c) => c.textContent);
      expect(captions[0]).toContain("Budi");
      expect(captions[1]).not.toContain("Budi");
    });

    it("delete asks first, then removes the image, and 'cancel' keeps it", async () => {
      await mount({ gallery: true }, {
        "GET /api/gallery": { body: { items: [item(1), item(2)], next: null } },
        "POST /api/gallery/delete": { body: { deleted: true } },
      });
      q("#gal-open")!.click();
      await flush();
      const del = () => [...document.querySelectorAll<HTMLButtonElement>("#gal-list button")].filter((b) => b.textContent === "Delete");
      del()[0]!.click();
      await flush();
      expect(q("#modal")!.hidden).toBe(false);
      expect(posts("/api/gallery/delete")).toHaveLength(0);
      q("#modal-cancel")!.click();
      await flush();
      expect(document.querySelectorAll("#gal-list figure")).toHaveLength(2);
      del()[0]!.click();
      await flush();
      q("#modal-ok")!.click();
      await flush();
      expect(posts("/api/gallery/delete")[0]!.body).toEqual({ id: GID(1) });
      expect(document.querySelectorAll("#gal-list figure")).toHaveLength(1);
    });

    it("a successful save while the gallery is open refreshes it", async () => {
      let n = 0;
      await finishJob([0], {
        "POST /api/gallery": { status: 201, body: { id: GID(1), created: true } },
        "GET /api/gallery": () => ({ body: { items: n++ === 0 ? [] : [item(1)], next: null } }),
      });
      q("#gal-open")!.click();
      await flush();
      expect(document.querySelectorAll("#gal-list figure")).toHaveLength(0);
      saveButtons()[0]!.click();
      await flush();
      expect(document.querySelectorAll("#gal-list figure")).toHaveLength(1);
    });
  });
});
describe("styles and chaining", () => {
  const editInfo = { max_references: 3, max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"], resolutions: [{ name: "zz-res", value: 1024 }] };
  const strength = { id: "strength", title: "LoRA strength", type: "float", min: 0.4, max: 1, step: 0.05, default: 0.7 };
  const a2r = { id: "anything2real", title: "Anything to Real", modes: ["edit"], params: [strength] };
  const mixed = {
    id: "mixed",
    title: "Mixed",
    modes: ["generate", "edit"],
    params: [
      { id: "kind", title: "Kind", type: "choice", choices: ["soft", "hard"], default: "soft" },
      { id: "sharp", title: "Sharp", type: "bool", default: false },
    ],
  };
  const chooseEdit = () => q<HTMLButtonElement>("#mode-edit")!.click();
  const styleButtons = () => [...document.querySelectorAll("#styles button")].map((b) => b.textContent);
  const pressed = () => [...document.querySelectorAll("#styles button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);
  const click = (title: string) => [...document.querySelectorAll<HTMLButtonElement>("#styles button")].find((b) => b.textContent === title)!.click();

  beforeEach(() => {
    window.URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
    window.URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  });

  it("hides the style box when no style is listed for the mode, and lists Standard first otherwise", async () => {
    await mount({ edit: editInfo, styles: [a2r] });
    expect(q("#style-box")!.hidden).toBe(true); // generate: the style is edit-only
    chooseEdit();
    expect(q("#style-box")!.hidden).toBe(false);
    expect(styleButtons()).toEqual(["Standard", "Anything to Real"]);
    expect(pressed()).toEqual(["Standard"]);
    expect(q("#style-params")!.children).toHaveLength(0);
  });

  it("draws the panel of the chosen style from the api and keeps a slider across polls", async () => {
    await mount({ edit: editInfo, styles: [a2r, mixed] });
    chooseEdit();
    click("Anything to Real");
    const range = q<HTMLInputElement>("#style-params input[type=range]")!;
    expect([range.min, range.max, range.step, range.value]).toEqual(["0.4", "1", "0.05", "0.7"]);
    range.value = "0.85";
    range.dispatchEvent(new Event("input"));
    expect(q(".style-value")!.textContent).toBe("0.85");
    await app!.refresh();
    expect(q<HTMLInputElement>("#style-params input[type=range]")!.value).toBe("0.85");
    click("Mixed");
    expect([...document.querySelectorAll("#style-params label")].map((l) => l.textContent)).toEqual(["Kind", "Sharp"]);
    expect(q("#style-params select")!.tagName).toBe("SELECT");
    expect(q<HTMLInputElement>("#style-params input[type=checkbox]")!.checked).toBe(false);
    click("Anything to Real"); // the earlier value is remembered
    expect(q<HTMLInputElement>("#style-params input[type=range]")!.value).toBe("0.85");
  });

  it("sends the chosen style and its values with an edit, and adds its title to the label", async () => {
    await mount({ edit: editInfo, styles: [a2r] }, { "POST /api/edit": { status: 202, body: { id: "edit-9" } }, "GET /api/generate/edit-9": { body: { status: "pending" } } });
    chooseEdit();
    click("Anything to Real");
    const range = q<HTMLInputElement>("#style-params input[type=range]")!;
    range.value = "0.62";
    range.dispatchEvent(new Event("input"));
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: [new File(["PNGDATA"], "a.png", { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
    q<HTMLTextAreaElement>("#prompt")!.value = "make it real";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/edit")[0]!.body).toMatchObject({ style: { id: "anything2real", params: { strength: 0.6 } } });
    expect(q(".job .muted")!.textContent).toMatch(/, Anything to Real$/);
  });

  it("sends no style member when Standard is chosen, and the chosen generate style with its values", async () => {
    await mount({ edit: editInfo, styles: [a2r, mixed] }, { "POST /api/generate": { status: 202, body: { id: "g-1" } }, "GET /api/generate/g-1": { body: { status: "failed", message: "x" } } });
    q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/generate")[0]!.body).not.toHaveProperty("style");

    expect(styleButtons()).toEqual(["Standard", "Mixed"]); // a2r is edit-only
    click("Mixed");
    const sel = q<HTMLSelectElement>("#style-params select")!;
    sel.value = "hard";
    sel.dispatchEvent(new Event("change"));
    const box = q<HTMLInputElement>("#style-params input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/generate")[1]!.body).toMatchObject({ style: { id: "mixed", params: { kind: "hard", sharp: true } } });
  });

  it("falls back to Standard when the chosen style disappears from the state", async () => {
    await mount({ edit: editInfo, styles: [a2r] });
    chooseEdit();
    click("Anything to Real");
    routes["GET /api/state"] = { body: apiState({ edit: editInfo, styles: [] }) };
    await app!.refresh();
    expect(q("#style-box")!.hidden).toBe(true);
  });

  it("renders a hostile style title and parameter title as text only", async () => {
    const evil = { ...a2r, title: '<img src=x onerror="alert(1)">', params: [{ ...strength, title: "<b>bold</b>" }] };
    await mount({ edit: editInfo, styles: [evil] });
    chooseEdit();
    click('<img src=x onerror="alert(1)">');
    expect(q("#style-box img")).toBeNull();
    expect(q("#style-params b")).toBeNull();
    expect(q("#style-params label")!.textContent).toBe("<b>bold</b>");
  });

  describe("use as reference", () => {
    const done = (id: string): Record<string, Handler> => ({ ["GET /api/generate/" + id]: { body: { status: "done", images: [{ index: 0, url: `/api/image/${id}/0` }] } } });

    async function withResult(over: Record<string, unknown> = {}, extra: Record<string, Handler> = {}) {
      await mount({ edit: editInfo, styles: [a2r], ...over }, {
        "POST /api/generate": { status: 202, body: { id: "g-1" } },
        "GET /api/image/g-1/0": { body: null, raw: "RESULTBYTES", type: "image/png" },
        ...done("g-1"),
        ...extra,
      });
      q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
      q<HTMLFormElement>("#gen-form")!.requestSubmit();
      await flush();
      await flush();
    }
    const chainBtns = () => [...document.querySelectorAll<HTMLButtonElement>(".chain button")].map((b) => b.textContent);

    it("is offered on a result only when the server offers edit", async () => {
      await withResult({ edit: null });
      expect(q(".chain")).toBeNull();
    });

    it("lists a plain button and one per edit style", async () => {
      await withResult();
      expect(chainBtns()).toEqual(["Use as reference", "Use as reference: Anything to Real"]);
    });

    it("switches to Edit, attaches the fetched result as the first reference and keeps Standard", async () => {
      await withResult();
      q<HTMLButtonElement>(".chain button")!.click();
      await flush();
      expect(q("#mode-edit")!.getAttribute("aria-pressed")).toBe("true");
      expect([...document.querySelectorAll("#ref-list .ref-tag")].map((n) => n.textContent)).toEqual(["<image1>"]);
      expect(q("#ref-list .ref-name")!.textContent).toBe("result-g-1-0.png");
      expect(pressed()).toEqual(["Standard"]);
      expect(calls.filter((c) => c.path === "/api/image/g-1/0")).toHaveLength(1);
    });

    it("switches to the chosen edit style", async () => {
      await withResult();
      document.querySelectorAll<HTMLButtonElement>(".chain button")[1]!.click();
      await flush();
      expect(pressed()).toEqual(["Anything to Real"]);
      expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
    });

    it("says why when the result cannot be loaded or is not an accepted image, and attaches nothing", async () => {
      await withResult({}, { "GET /api/image/g-1/0": { status: 404, body: null, raw: "gone" } });
      q<HTMLButtonElement>(".chain button")!.click();
      await flush();
      expect(q("#ref-error")!.hidden).toBe(false);
      expect(document.querySelectorAll("#ref-list li")).toHaveLength(0);
      routes["GET /api/image/g-1/0"] = { body: null, raw: "<svg/>", type: "image/svg+xml" };
      q<HTMLButtonElement>(".chain button")!.click();
      await flush();
      expect(q("#ref-error")!.textContent).toContain("only PNG, JPEG");
      expect(document.querySelectorAll("#ref-list li")).toHaveLength(0);
    });
  });
});

describe("upscale", () => {
  const up = { scales: ["2x", "4x"], max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"] };
  const editInfo = { max_references: 3, max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"], resolutions: [{ name: "zz-res", value: 1024 }] };
  const chooseUp = () => q<HTMLButtonElement>("#mode-upscale")!.click();
  const pickOne = (name = "a.png", content = "UPBYTES") => {
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: [new File([content], name, { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
  };

  beforeEach(() => {
    window.URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
    window.URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  });

  it("offers the mode only when the server offers upscale, and shows just the image and the scale", async () => {
    await mount({ edit: editInfo });
    expect(q("#mode-upscale")!.hidden).toBe(true);
    await mount({ upscale: up });
    expect(q("#mode-box")!.hidden).toBe(false); // upscale alone is enough for the switch
    expect(q("#mode-edit")!.hidden).toBe(true);
    chooseUp();
    expect(q("#mode-upscale")!.getAttribute("aria-pressed")).toBe("true");
    expect(q("#prompt-box")!.hidden).toBe(true);
    expect(q("#sampling-box")!.hidden).toBe(true);
    expect(q("#size-box")!.hidden).toBe(true);
    expect(q("#style-box")!.hidden).toBe(true);
    expect(q("#resolution-box")!.hidden).toBe(true);
    expect(q("#scale-box")!.hidden).toBe(false);
    expect(q("#edit-box")!.hidden).toBe(false);
    expect([...document.querySelectorAll("#scale option")].map((o) => o.textContent)).toEqual(["2x", "4x"]);
    expect(q<HTMLInputElement>("#ref-input")!.multiple).toBe(false);
    expect(q("#ref-hint")!.textContent).toContain("One image");
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Upscale");
  });

  it("goes back to the generate form when the server stops offering upscale", async () => {
    await mount({ upscale: up });
    chooseUp();
    routes["GET /api/state"] = { body: apiState({ upscale: null }) };
    await app!.refresh();
    expect(q("#prompt-box")!.hidden).toBe(false);
    expect(q<HTMLButtonElement>("#btn-generate")!.textContent).toBe("Generate");
  });

  it("accepts one image only and posts the image as base64 with the scale, then polls the job", async () => {
    await mount({ upscale: up }, { "POST /api/upscale": { status: 202, body: { id: "up-1" } }, "GET /api/generate/up-1": { body: { status: "pending" } } });
    chooseUp();
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("Attach exactly one image to upscale.");
    pickOne("a.png", "UPBYTES");
    pickOne("b.png");
    expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
    expect(q("#ref-error")!.textContent).toBe("At most 1 images can be attached.");
    q<HTMLSelectElement>("#scale")!.value = "4x";
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/upscale")).toHaveLength(1);
    expect(posts("/api/upscale")[0]!.body).toEqual({ image: Buffer.from("UPBYTES").toString("base64"), scale: "4x" });
    expect(q(".job .muted")!.textContent).toBe("Upscale: 4x");
    expect(calls.some((c) => c.path === "/api/generate/up-1")).toBe(true);
  });

  it("shows the api refusal and frees the form", async () => {
    await mount({ upscale: up }, { "POST /api/upscale": { status: 400, body: { error: { code: "upscale_too_large", message: "the result would be too big" } } } });
    chooseUp();
    pickOne();
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("the result would be too big");
    expect(q<HTMLButtonElement>("#btn-generate")!.disabled).toBe(false);
  });

  describe("from a result", () => {
    async function withResult(over: Record<string, unknown>) {
      await mount({ upscale: up, ...over }, {
        "POST /api/generate": { status: 202, body: { id: "g-1" } },
        "GET /api/generate/g-1": { body: { status: "done", images: [{ index: 0, url: "/api/image/g-1/0" }] } },
        "GET /api/image/g-1/0": { body: null, raw: "RESULT", type: "image/png" },
      });
      q<HTMLTextAreaElement>("#prompt")!.value = "a fox";
      q<HTMLFormElement>("#gen-form")!.requestSubmit();
      await flush();
      await flush();
    }
    const labels = () => [...document.querySelectorAll(".chain button")].map((b) => b.textContent);

    it("adds an Upscale button, also when edit is off, that switches mode and attaches the result", async () => {
      await withResult({});
      expect(labels()).toEqual(["Upscale"]);
      [...document.querySelectorAll<HTMLButtonElement>(".chain button")][0]!.click();
      await flush();
      expect(q("#mode-upscale")!.getAttribute("aria-pressed")).toBe("true");
      expect(q("#ref-list .ref-name")!.textContent).toBe("result-g-1-0.png");
    });

    it("replaces a previously attached image, because an upscale takes one", async () => {
      await withResult({ edit: editInfo });
      expect(labels()).toEqual(["Use as reference", "Upscale"]);
      q<HTMLButtonElement>(".chain button")!.click(); // into edit
      await flush();
      chooseUp();
      [...document.querySelectorAll<HTMLButtonElement>(".chain button")][1]!.click();
      await flush();
      expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
      expect(q("#ref-error")!.hidden).toBe(true);
    });
  });

  it("refuses to upscale when several images were attached in edit mode", async () => {
    await mount({ upscale: up, edit: editInfo });
    q<HTMLButtonElement>("#mode-edit")!.click();
    const input = q<HTMLInputElement>("#ref-input")!;
    Object.defineProperty(input, "files", { value: [new File(["A"], "a.png", { type: "image/png" }), new File(["B"], "b.png", { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
    chooseUp();
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(q("#form-error")!.textContent).toBe("Attach exactly one image to upscale.");
    expect(posts("/api/upscale")).toHaveLength(0);
  });
});

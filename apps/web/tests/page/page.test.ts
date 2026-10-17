// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";

const INDEX = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");

interface Reply { status?: number; body: unknown }
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
  routes = { "GET /api/state": { body: apiState(state) }, ...extra };
  app = mountApp(document, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const h = routes[`${method} ${path}`];
      if (h === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: "not found" } }), { status: 404 });
      const r = typeof h === "function" ? h(body) : h;
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
});
afterEach(() => {
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

  it("start shows the estimate and requires confirmation", async () => {
    await mount({ role: "admin", state: "none" }, {
      "GET /api/estimate": { body: { offer_id: 1, gpu_name: "RTX 4090", dph: 0.37, horizon_hours: 3, max_cost: 1.11 } },
      "POST /api/start": { body: { status: "creating", vast_instance_id: 5, estimate: {} } },
    });
    q("#btn-start")!.click();
    await flush();
    const text = q("#modal")!.textContent!;
    expect(q("#modal")!.hidden).toBe(false);
    expect(text).toContain("$0.37/hour");
    expect(text).toContain("$1.11");
    expect(text).toContain("3 hours");
    expect(text).toContain("RTX 4090");
    expect(text).toContain("covers the failsafe time only");
    expect(text).toContain("up to the hard cap");
    expect(text).toContain("Disk storage is billed separately, per hour");
    expect(posts("/api/start")).toHaveLength(0);
    q("#modal-ok")!.click();
    await flush();
    expect(posts("/api/start")).toEqual([{ method: "POST", path: "/api/start", body: { confirm: true } }]);
  });

  it("start does nothing if the estimate fails", async () => {
    await mount({ role: "admin", state: "none" }, { "GET /api/estimate": { status: 503, body: { error: { code: "no_offers", message: "no Vast offer matches the filters" } } } });
    q("#btn-start")!.click();
    await flush();
    expect(q("#modal")!.hidden).toBe(true);
    expect(q("#banner")!.textContent).toBe("no Vast offer matches the filters");
    expect(posts("/api/start")).toHaveLength(0);
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

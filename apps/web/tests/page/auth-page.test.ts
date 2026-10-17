// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";

const INDEX = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");

interface Reply { status?: number; body?: unknown; fail?: boolean }
interface Call { method: string; path: string; body: unknown; contentType: string | null }

const STATE = {
  state: "ready", role: "member", agent: null, agent_unreachable: false, failed: null, destroy_failed: null,
  dph: 0.36, uptime_s: 600, cost_so_far: 0.06, progress: null,
  remaining: { idle_s: 1500, failsafe_s: 9000, hard_cap_s: 20000 }, unknown: [],
  presets: [{ name: "turbo", steps: 7 }], sizes: [{ name: "sq", width: 512, height: 512 }],
};

let app: App | null = null;
let calls: Call[] = [];
let routes: Record<string, Reply> = {};
let timers: Map<number, () => void> = new Map();
let nextTimer = 1;
let meGate: Promise<void> | null = null;

async function mount(extra: Record<string, Reply> = {}): Promise<App> {
  routes = { "GET /api/me": { body: { name: "Ada", username: "ada", role: "member" } }, "GET /api/state": { body: STATE }, ...extra };
  app = mountApp(document, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, contentType: headers.get("content-type") });
      if (path === "/api/me" && meGate) await meGate;
      const r = routes[`${method} ${path}`];
      if (r === undefined) return new Response("{}", { status: 404 });
      if (r.fail) throw new TypeError("network");
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }) as typeof fetch,
    now: () => 1_000_000,
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
  });
  await app.ready;
  return app;
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const visible = (sel: string) => q(sel) !== null && !q(sel)!.hidden;
async function fireTimers(): Promise<void> {
  const pending = [...timers.entries()];
  timers = new Map();
  for (const [, fn] of pending) fn();
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
  window.history.replaceState(null, "", "/");
  calls = [];
  timers = new Map();
  meGate = null;
});
afterEach(() => {
  app?.stop();
  app = null;
});

describe("login screen", () => {
  it("shows a plain login link on 401 and no app", async () => {
    await mount({ "GET /api/me": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    expect(visible("#login-screen")).toBe(true);
    expect(visible("#app")).toBe(false);
    const link = q<HTMLAnchorElement>("#login-link")!;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/auth/login?next=/");
    expect(link.textContent).toBe("Login with Authentik");
    expect(visible("#login-message")).toBe(false);
    expect(calls.filter((c) => c.path === "/api/state")).toHaveLength(0);
  });

  it.each([
    ["access_denied", "This account has no access."],
    ["session_too_large", "Login failed, please try again."],
    ["whatever_new", "Login failed, please try again."],
  ])("maps login_error=%s", async (code, text) => {
    window.history.replaceState(null, "", `/?login_error=${code}`);
    await mount({ "GET /api/me": { status: 401 } });
    expect(q("#login-message")!.textContent).toBe(text);
    expect(q("#login-message")!.hidden).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("never reflects a hostile login_error value", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    window.history.replaceState(null, "", `/?login_error=${encodeURIComponent(hostile)}&keep=1`);
    await mount({ "GET /api/me": { status: 401 } });
    expect(q("#login-message")!.textContent).toBe("Login failed, please try again.");
    expect(document.body.innerHTML).not.toContain("onerror");
    expect(document.querySelector("img")).toBeNull();
    expect(window.location.search).toBe("?keep=1");
  });

  it("does not render the app before /api/me answers", async () => {
    let release!: () => void;
    meGate = new Promise((r) => { release = r; });
    const mounting = mount();
    await flush();
    expect(visible("#app")).toBe(false);
    expect(visible("#login-screen")).toBe(false);
    expect(visible("#loading")).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["/api/me"]);
    release();
    await mounting;
    expect(visible("#app")).toBe(true);
    expect(visible("#loading")).toBe(false);
  });

  it("offers a retry when /api/me cannot be reached", async () => {
    await mount({ "GET /api/me": { fail: true } });
    expect(visible("#loading-error")).toBe(true);
    expect(visible("#app")).toBe(false);
    routes["GET /api/me"] = { body: { name: "Ada", username: "ada", role: "member" } };
    q<HTMLButtonElement>("#btn-retry")!.click();
    await flush();
    expect(visible("#app")).toBe(true);
  });
});

describe("logged in", () => {
  it("shows the name as text and a logout button", async () => {
    await mount({ "GET /api/me": { body: { name: "<b>Eve</b>", username: "eve", role: "member" } } });
    expect(visible("#app")).toBe(true);
    expect(q("#user-name")!.textContent).toBe("<b>Eve</b>");
    expect(q("#user-name b")).toBeNull();
    expect(q("#btn-logout")!.textContent).toBe("Logout");
  });

  it("logout posts {} as JSON and shows the login screen", async () => {
    await mount({ "POST /auth/logout": { body: { ok: true } } });
    q<HTMLButtonElement>("#btn-logout")!.click();
    await flush();
    const post = calls.find((c) => c.method === "POST" && c.path === "/auth/logout")!;
    expect(post.body).toEqual({});
    expect(post.contentType).toBe("application/json");
    expect(visible("#login-screen")).toBe(true);
    expect(visible("#app")).toBe(false);
    expect(visible("#login-message")).toBe(false);
  });

  it("keeps the page and shows an error when logout fails", async () => {
    await mount({ "POST /auth/logout": { status: 500, body: {} } });
    q<HTMLButtonElement>("#btn-logout")!.click();
    await flush();
    expect(visible("#app")).toBe(true);
    expect(visible("#logout-error")).toBe(true);
  });
});

describe("access lost", () => {
  it("shows the no-access screen with Logout on 403 from /api/me", async () => {
    await mount({ "GET /api/me": { status: 403 }, "POST /auth/logout": { body: {} } });
    expect(visible("#noaccess-screen")).toBe(true);
    expect(q("#noaccess-title")!.textContent).toBe("No access for this account");
    expect(visible("#app")).toBe(false);
    q<HTMLButtonElement>("#btn-logout-noaccess")!.click();
    await flush();
    expect(visible("#login-screen")).toBe(true);
  });

  it("a later 403 with a revoked role shows the no-access screen and stops polling", async () => {
    await mount();
    routes["GET /api/state"] = { status: 403, body: { error: { code: "forbidden", message: "x" } } };
    routes["GET /api/me"] = { status: 403 };
    await fireTimers();
    expect(visible("#noaccess-screen")).toBe(true);
    const n = calls.length;
    await fireTimers();
    expect(calls).toHaveLength(n);
    expect(timers.size).toBe(0);
  });

  it("a later 403 that is only a role limit keeps the app", async () => {
    await mount();
    routes["GET /api/state"] = { status: 403, body: { error: { code: "forbidden", message: "nope" } } };
    await fireTimers();
    expect(visible("#app")).toBe(true);
    expect(visible("#noaccess-screen")).toBe(false);
  });

  it("a later 401 shows the session-expired message and stops all timers", async () => {
    await mount();
    expect(timers.size).toBeGreaterThan(0);
    routes["GET /api/state"] = { status: 401 };
    await fireTimers();
    expect(visible("#login-screen")).toBe(true);
    expect(q("#login-message")!.textContent).toBe("Your session expired, please log in again.");
    expect(visible("#app")).toBe(false);
    const n = calls.length;
    await fireTimers();
    await fireTimers();
    expect(calls).toHaveLength(n);
    expect(timers.size).toBe(0);
  });
});

describe("index.html", () => {
  it("has no inline script, style or handlers", () => {
    expect(INDEX).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(INDEX).not.toMatch(/<style/i);
    expect(INDEX).not.toMatch(/\son[a-z]+\s*=/i);
    expect(INDEX).not.toMatch(/\sstyle\s*=/i);
  });
});

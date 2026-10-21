// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountApp, type App } from "../../public/ui.js";
import { DEFAULT_ICON, ICONS, iconNode } from "../../public/icons.js";

// The tool menu: a sidebar on wide screens, a drawer on narrow ones. Every entry is one tool (a plain mode or a
// style in a mode) with its own panel; choosing one must do exactly what the old mode switch and style selector did.

const INDEX = readFileSync(join(import.meta.dirname, "../../public/index.html"), "utf8");

interface Reply { status?: number; body: unknown; raw?: string; type?: string }
type Handler = Reply | ((body: unknown) => Reply);
interface Call { method: string; path: string; body: unknown; raw: string | undefined }

const editInfo = { max_references: 3, max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"], resolutions: [{ name: "zz-res", value: 1024 }] };
const upscaleInfo = { scales: ["2x", "4x"], max_bytes: 1000, max_pixels: 1_000_000, types: ["png", "jpeg"] };
const guidance = { min: 1, max: 6, step: 0.5, default: 1 };
const advanced = { generate: { negative_prompt: true, cfg: true }, edit: { negative_prompt: true, cfg: false }, negative_prompt_max_chars: 200 };

const styles = [
  {
    id: "portrait_photo", title: "Portrait photo", kind: "preset", modes: ["generate"], params: [], prompt_optional: true, references: null,
    hint: "Defaults are untested.", defaults: { negative_prompt: "cartoon, blurry", cfg: 3 },
  },
  {
    id: "faceswap", title: "Face swap", kind: "preset", modes: ["edit"], params: [], prompt_optional: true,
    references: { min: 2, max: 2, labels: ["Scene to keep", "Face to use"] }, hint: "Only use a face with consent.", defaults: {},
  },
  {
    id: "photo_restore", title: "Restore old photo", kind: "preset", modes: ["edit"], params: [], prompt_optional: true, references: null,
    hint: null, defaults: { negative_prompt: "changed faces" },
  },
];

const entry = (id: string, title: string, category: string, tool: string, style: string | null, icon: string, description: string | null = null) =>
  ({ id, title, description, icon, category, tool, style, available: true });

/** Shaped like the menu the shipped profile resolves to (a subset). */
const MENU = {
  categories: [{ id: "create", title: "Create" }, { id: "edit", title: "Edit & combine" }, { id: "enhance", title: "Enhance" }],
  items: [
    entry("text_to_image", "Text to image", "create", "generate", null, "image", "Describe a picture and generate it."),
    entry("portrait_photo", "Portrait photo", "create", "generate", "portrait_photo", "user", "A realistic portrait with natural skin and soft light."),
    entry("free_edit", "Free edit", "edit", "edit", null, "wand", "Change or combine your images with an instruction."),
    entry("faceswap", "Face swap", "edit", "edit", "faceswap", "swap", "Put the face from one photo onto the person in another."),
    entry("photo_restore", "Restore old photo", "enhance", "edit", "photo_restore", "restore", "Repair scratches, noise and faded colors of an old photo."),
    entry("upscale", "Upscale", "enhance", "upscale", null, "expand", "Make an image two or four times bigger."),
  ],
};

function apiState(over: Record<string, unknown> = {}) {
  return {
    state: "ready", role: "member", record: null, vast: null, vast_error: null,
    agent: { state: "ready", reason: null, queue: { running: 0, pending: 0 }, gpu: {}, failsafe_alive: true, destroy: { pending: false, attempts: 0 } },
    agent_error: null, agent_unreachable: false, failed: null, destroy_failed: null, dph: 0.3, uptime_s: 1, cost_so_far: 0,
    progress: null, gpu_name: null, download: null, remaining: { idle_s: 100, failsafe_s: 100, hard_cap_s: 100 }, unknown: [],
    presets: [{ name: "zz-turbo", steps: 7 }, { name: "zz-slow", steps: 99 }],
    sizes: [{ name: "zz-square", width: 512, height: 512 }, { name: "zz-wide", width: 768, height: 512 }],
    edit: editInfo, upscale: upscaleInfo, styles, guidance, advanced, menu: MENU,
    ...over,
  };
}

let app: App | null = null;
let calls: Call[] = [];
let routes: Record<string, Handler> = {};

async function mount(over: Record<string, unknown> = {}, extra: Record<string, Handler> = {}): Promise<App> {
  routes = { "GET /api/me": { body: { name: "Tester", username: "tester", role: "member" } }, "GET /api/state": { body: apiState(over) }, ...extra };
  app = mountApp(document, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const raw = typeof init?.body === "string" ? init.body : undefined;
      const body = raw === undefined ? undefined : JSON.parse(raw);
      calls.push({ method, path, body, raw });
      const h = routes[`${method} ${path}`];
      if (h === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: "not found" } }), { status: 404 });
      const r = typeof h === "function" ? h(body) : h;
      if (r.raw !== undefined) return new Response(r.raw, { status: r.status ?? 200, headers: { "Content-Type": r.type ?? "image/png" } });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as typeof fetch,
    now: () => 1_000_000,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  await app.ready;
  return app;
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const item = (id: string) => q<HTMLButtonElement>(`.menu-item[data-tool-id="${id}"]`);
const items = () => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")];
const ids = () => items().map((b) => b.dataset["toolId"]);
const current = () => [...document.querySelectorAll(".menu-item[aria-current]")].map((b) => b.getAttribute("data-tool-id"));
const choose = (id: string) => item(id)!.click();
const key = (target: Element, k: string, shiftKey = false) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
const search = (text: string) => {
  const box = q<HTMLInputElement>("#menu-search")!;
  box.value = text;
  box.dispatchEvent(new Event("input"));
};
const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);
const pathsOf = (svg: Element | null) => [...(svg?.querySelectorAll("path") ?? [])].map((p) => p.getAttribute("d"));
const attach = (...names: string[]) => {
  const input = q<HTMLInputElement>("#ref-input")!;
  Object.defineProperty(input, "files", { value: names.map((n) => new File(["PNGDATA"], n, { type: "image/png" })), configurable: true });
  input.dispatchEvent(new Event("change"));
};
const submit = async (prompt: string) => {
  q<HTMLTextAreaElement>("#prompt")!.value = prompt;
  q<HTMLFormElement>("#gen-form")!.requestSubmit();
  await flush();
};
const b64 = (text: string) => Buffer.from(text).toString("base64");

beforeEach(() => {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
  calls = [];
  window.localStorage.clear();
  window.URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
  window.URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
});
afterEach(() => {
  vi.restoreAllMocks();
  app?.stop();
  app = null;
  delete (window as { __pwned?: unknown }).__pwned;
});

describe("the page layout", () => {
  it("has the sidebar instead of the old mode tabs and style sub-menu, and the tool panel before the other cards", () => {
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
    expect(q("#mode-box")).toBeNull();
    expect(q("#styles")).toBeNull();
    expect(q("#app #tool-nav")).not.toBeNull();
    expect(q("#tool-nav #menu-search")).not.toBeNull();
    expect(q("#page header #menu-open")!.textContent).toBe("Menu");
    // The status, the boot console and the usage history moved out of the main column: the server panel, the log
    // dialog and the history dialog.
    const order = [...document.querySelectorAll("#main > section")].map((s) => s.id || s.getAttribute("aria-labelledby"));
    expect(order).toEqual(["tool-card", "hist-title", "gallery-card"]);
    expect(q("#app > #usage-card")).not.toBeNull();
    expect(q("#main #status-title")).toBeNull();
    expect(q("#main #console-card")).toBeNull();
    expect(q("#app > #status-panel #status-title")).not.toBeNull();
    expect(q("#app > #console-card")).not.toBeNull();
  });
});

describe("the sidebar", () => {
  it("lists every tool grouped by category, with headings, an icon and a title, and highlights the first", async () => {
    await mount();
    const groups = [...document.querySelectorAll("#menu-list .menu-group")];
    expect(groups.map((g) => g.querySelector(".menu-heading")!.textContent)).toEqual(["Create", "Edit & combine", "Enhance"]);
    expect(groups.map((g) => [...g.querySelectorAll(".menu-item")].map((b) => b.getAttribute("data-tool-id")))).toEqual([
      ["text_to_image", "portrait_photo"], ["free_edit", "faceswap"], ["photo_restore", "upscale"],
    ]);
    // Each group is labelled by its heading.
    expect(groups[1]!.getAttribute("aria-labelledby")).toBe(groups[1]!.querySelector(".menu-heading")!.id);
    const b = item("faceswap")!;
    expect(b.type).toBe("button");
    expect(b.querySelector(".menu-title")!.textContent).toBe("Face swap");
    expect(pathsOf(b.querySelector("svg"))).toEqual([...ICONS["swap"]!]);
    expect(b.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(current()).toEqual(["text_to_image"]);
    expect(item("text_to_image")!.getAttribute("aria-current")).toBe("page");
    expect(q("#gen-title")!.textContent).toBe("Text to image");
    expect(q("#tool-desc")!.textContent).toBe("Describe a picture and generate it.");
    expect(q("#tool-desc")!.hidden).toBe(false);
  });

  it("shows the chosen tool's own panel: title, description, labelled slots, notes and its action", async () => {
    await mount();
    choose("faceswap");
    expect(current()).toEqual(["faceswap"]);
    expect(q("#gen-title")!.textContent).toBe("Face swap");
    expect(q("#tool-desc")!.textContent).toBe("Put the face from one photo onto the person in another.");
    expect(q("#style-hint")!.textContent).toBe("Only use a face with consent.");
    expect(q("#prompt-label")!.textContent).toBe("Notes (optional)");
    expect([...document.querySelectorAll("#ref-list li")].map((li) => li.textContent)).toEqual(["Scene to keep: not attached yet", "Face to use: not attached yet"]);
    expect(q("#edit-box")!.hidden).toBe(false);
    expect(q("#size-box")!.hidden).toBe(true);
    expect(q("#btn-generate")!.textContent).toBe("Edit");
    choose("upscale");
    expect(q("#gen-title")!.textContent).toBe("Upscale");
    expect(q("#prompt-box")!.hidden).toBe(true);
    expect(q("#scale-box")!.hidden).toBe(false);
    expect(q("#advanced-box")!.hidden).toBe(true);
    expect(q("#btn-generate")!.textContent).toBe("Upscale");
    choose("text_to_image");
    expect(q("#prompt-label")!.textContent).toBe("Prompt");
    expect(q("#style-hint")!.hidden).toBe(true);
    expect(q("#size-box")!.hidden).toBe(false);
  });

  it("keeps the menu (and the focus in it) across polls", async () => {
    await mount();
    const before = item("free_edit")!;
    before.focus();
    await app!.refresh();
    expect(item("free_edit")).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it("draws an unknown or hostile icon name as the default icon, never markup from the server", async () => {
    const evilIcon = '<svg onload="window.__pwned=1"><path d="M0 0"/></svg>';
    await mount({ menu: { ...MENU, items: [{ ...MENU.items[0]!, icon: "rocket" }, { ...MENU.items[1]!, icon: evilIcon }, { ...MENU.items[2]!, icon: "__proto__" }] } });
    for (const b of items()) {
      expect(b.querySelectorAll("svg")).toHaveLength(1);
      expect(pathsOf(b.querySelector("svg"))).toEqual([...ICONS[DEFAULT_ICON]!]);
      expect(b.querySelector("svg")!.getAttribute("onload")).toBeNull();
    }
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("builds icons from the closed set only (also for names on Object.prototype)", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "", "IMAGE"]) {
      expect(pathsOf(iconNode(document, name))).toEqual([...ICONS[DEFAULT_ICON]!]);
    }
    expect(pathsOf(iconNode(document, "camera"))).toEqual([...ICONS["camera"]!]);
    expect(iconNode(document, "image").namespaceURI).toBe("http://www.w3.org/2000/svg"); // config-lint: ok (XML namespace name)
  });

  it("puts hostile titles, descriptions and category titles in as text only", async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    await mount({
      menu: {
        categories: [{ id: "create", title: evil }],
        items: [{ ...MENU.items[0]!, title: evil, description: `<b>${evil}</b>` }],
      },
    });
    expect(q("#tool-nav img")).toBeNull();
    expect(q("#tool-card img")).toBeNull();
    expect(q("#tool-card b")).toBeNull();
    expect(q(".menu-heading")!.textContent).toBe(evil);
    expect(q(".menu-title")!.textContent).toBe(evil);
    expect(q("#gen-title")!.textContent).toBe(evil);
    expect(q("#tool-desc")!.textContent).toBe(`<b>${evil}</b>`);
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("leaves out entries whose mode is off here, and falls back to the first entry when the chosen one goes", async () => {
    await mount({ edit: null });
    expect(ids()).toEqual(["text_to_image", "portrait_photo", "upscale"]);
    choose("upscale");
    routes["GET /api/state"] = { body: apiState({ edit: null, upscale: null }) };
    await app!.refresh();
    expect(ids()).toEqual(["text_to_image", "portrait_photo"]);
    expect(current()).toEqual(["text_to_image"]);
    expect(q("#scale-box")!.hidden).toBe(true);
    // The fallback is now the selection: upscale coming back does not pull the form away under the user.
    routes["GET /api/state"] = { body: apiState({ edit: null }) };
    await app!.refresh();
    expect(current()).toEqual(["text_to_image"]);
  });
});

describe("search", () => {
  it("filters on title and description ignoring case, hides empty groups and says when nothing matches", async () => {
    await mount();
    search("PHOTO");
    expect(ids()).toEqual(["portrait_photo", "faceswap", "photo_restore"]);
    expect([...document.querySelectorAll(".menu-heading")].map((h) => h.textContent)).toEqual(["Create", "Edit & combine", "Enhance"]);
    search("bigger");
    expect(ids()).toEqual(["upscale"]);
    expect([...document.querySelectorAll(".menu-heading")].map((h) => h.textContent)).toEqual(["Enhance"]);
    expect(q("#menu-empty")!.hidden).toBe(true);
    search("zebra");
    expect(ids()).toEqual([]);
    expect(q("#menu-empty")!.hidden).toBe(false);
    search("");
    expect(ids()).toHaveLength(6);
    expect(q("#menu-empty")!.hidden).toBe(true);
    expect(current()).toEqual(["text_to_image"]); // searching never changes the selection
  });

  it("treats the search text as text: markup in it creates nothing", async () => {
    await mount();
    search('<img src=x onerror="window.__pwned=1">');
    expect(q("#tool-nav img")).toBeNull();
    expect(q("#menu-empty")!.hidden).toBe(false);
    expect(q("#menu-empty")!.textContent).toBe("No tool matches.");
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("Enter chooses the first match, ArrowDown moves into the list", async () => {
    await mount();
    const box = q<HTMLInputElement>("#menu-search")!;
    search("swap");
    box.focus();
    key(box, "ArrowDown");
    expect(document.activeElement).toBe(item("faceswap"));
    key(box, "Enter");
    expect(current()).toEqual(["faceswap"]);
    expect(q("#gen-title")!.textContent).toBe("Face swap");
  });
});

describe("keyboard", () => {
  it("moves with the arrow keys, Home and End, and back up into the search box", async () => {
    await mount();
    const box = q<HTMLInputElement>("#menu-search")!;
    item("text_to_image")!.focus();
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(item("portrait_photo"));
    key(document.activeElement!, "ArrowDown"); // across a category
    expect(document.activeElement).toBe(item("free_edit"));
    key(document.activeElement!, "End");
    expect(document.activeElement).toBe(item("upscale"));
    key(document.activeElement!, "ArrowDown"); // stays on the last
    expect(document.activeElement).toBe(item("upscale"));
    key(document.activeElement!, "Home");
    expect(document.activeElement).toBe(item("text_to_image"));
    key(document.activeElement!, "ArrowUp");
    expect(document.activeElement).toBe(box);
    // Every entry is an ordinary button, so Tab reaches each one in order.
    expect(items().every((b) => b.tabIndex === 0 && !b.disabled)).toBe(true);
  });

  it("keeps the focus on the entry chosen with the keyboard on a wide screen", async () => {
    await mount();
    const b = item("free_edit")!;
    b.focus();
    b.click();
    expect(current()).toEqual(["free_edit"]);
    expect(document.activeElement).toBe(b);
  });
});

describe("the remembered tool", () => {
  it("remembers the chosen entry and selects it again on the next visit", async () => {
    await mount();
    choose("photo_restore");
    expect(window.localStorage.getItem("vast-comfy.tool")).toBe("photo_restore");
    app!.stop();
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
    await mount();
    expect(current()).toEqual(["photo_restore"]);
    expect(q("#gen-title")!.textContent).toBe("Restore old photo");
    expect(q<HTMLTextAreaElement>("#negative")!.value).toBe("changed faces"); // the style's pre-fill, as if chosen by hand
  });

  it("falls back to the first entry for an unknown or hostile stored id", async () => {
    for (const stored of ["no_such_tool", "__proto__", '"><img src=x onerror="window.__pwned=1">', "x".repeat(5000)]) {
      window.localStorage.setItem("vast-comfy.tool", stored);
      document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(INDEX)![1]!;
      await mount();
      expect(current()).toEqual(["text_to_image"]);
      expect(q("#gen-title")!.textContent).toBe("Text to image");
      expect(q("#tool-nav img")).toBeNull();
      app!.stop();
    }
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("works when the browser refuses storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await mount();
    expect(current()).toEqual(["text_to_image"]);
    choose("free_edit");
    expect(current()).toEqual(["free_edit"]);
    expect(q("#btn-generate")!.textContent).toBe("Edit");
  });
});

describe("the drawer (narrow screens)", () => {
  const open = () => q<HTMLButtonElement>("#menu-open")!.click();
  const nav = () => q("#tool-nav")!;
  const isOpen = () => nav().classList.contains("open");

  it("opens from the Menu button: the page behind is inert and the focus goes to the search box", async () => {
    await mount();
    expect(isOpen()).toBe(false);
    expect(q("#menu-open")!.getAttribute("aria-expanded")).toBe("false");
    expect(q("#menu-open")!.getAttribute("aria-controls")).toBe("tool-nav");
    open();
    expect(isOpen()).toBe(true);
    expect(q("#menu-open")!.getAttribute("aria-expanded")).toBe("true");
    expect(q("#menu-backdrop")!.hidden).toBe(false);
    expect(q("#page")!.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(q("#menu-search"));
  });

  it("closes with Escape, the backdrop and the close button, and gives the focus back to the Menu button", async () => {
    await mount();
    const menuBtn = q<HTMLButtonElement>("#menu-open")!;
    for (const close of [
      () => key(document.activeElement!, "Escape"),
      () => q("#menu-backdrop")!.click(),
      () => q<HTMLButtonElement>("#menu-close")!.click(),
    ]) {
      open();
      expect(isOpen()).toBe(true);
      close();
      expect(isOpen()).toBe(false);
      expect(q("#menu-backdrop")!.hidden).toBe(true);
      expect(q("#page")!.hasAttribute("inert")).toBe(false);
      expect(menuBtn.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(menuBtn);
    }
  });

  it("traps Tab and Shift+Tab inside the open drawer", async () => {
    await mount();
    open();
    const closeBtn = q<HTMLButtonElement>("#menu-close")!;
    const last = item("upscale")!;
    last.focus();
    key(last, "Tab");
    expect(document.activeElement).toBe(closeBtn);
    key(closeBtn, "Tab", true);
    expect(document.activeElement).toBe(last);
    // In the middle Tab is left to the browser.
    const mid = item("free_edit")!;
    mid.focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    mid.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    // With a search that leaves no entry, the search box is the last stop.
    search("zebra");
    const box = q<HTMLInputElement>("#menu-search")!;
    box.focus();
    key(box, "Tab");
    expect(document.activeElement).toBe(closeBtn);
  });

  it("does not trap Tab while the drawer is closed", async () => {
    await mount();
    const last = item("upscale")!;
    last.focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    last.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("closes after a choice and moves the focus to the chosen tool's panel", async () => {
    await mount();
    open();
    choose("faceswap");
    expect(isOpen()).toBe(false);
    expect(q("#page")!.hasAttribute("inert")).toBe(false);
    expect(current()).toEqual(["faceswap"]);
    expect(document.activeElement).toBe(q("#gen-title"));
  });

  it("closes when the screen becomes wide", async () => {
    let listener: ((e: { matches: boolean }) => void) | null = null;
    window.matchMedia = ((query: string) => ({
      matches: false, media: query,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { listener = fn; },
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      await mount();
      open();
      listener!({ matches: true });
      expect(isOpen()).toBe(false);
      expect(q("#page")!.hasAttribute("inert")).toBe(false);
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });
});

describe("requests stay byte-identical", () => {
  const jobs = {
    "POST /api/generate": { status: 202, body: { id: "g-1" } },
    "POST /api/edit": { status: 202, body: { id: "e-1" } },
    "POST /api/upscale": { status: 202, body: { id: "u-1" } },
  };

  it("plain text to image sends exactly {prompt, preset, size}", async () => {
    await mount({}, jobs);
    await submit("a red fox");
    expect(posts("/api/generate")[0]!.raw).toBe('{"prompt":"a red fox","preset":"zz-turbo","size":"zz-square"}');
  });

  it("a generate style sends its id and the defaults it pre-filled, in the old order", async () => {
    await mount({}, jobs);
    choose("portrait_photo");
    expect(q<HTMLDetailsElement>("#advanced-box")!.open).toBe(true);
    expect(q<HTMLTextAreaElement>("#negative")!.value).toBe("cartoon, blurry");
    await submit("");
    expect(posts("/api/generate")[0]!.raw).toBe(
      '{"prompt":"","preset":"zz-turbo","size":"zz-square","negative_prompt":"cartoon, blurry","cfg":3,"style":{"id":"portrait_photo","params":{}}}',
    );
  });

  it("leaving a style undoes its pre-fill: plain text to image sends the plain body again", async () => {
    await mount({}, jobs);
    choose("portrait_photo");
    choose("text_to_image");
    expect(q<HTMLTextAreaElement>("#negative")!.value).toBe("");
    await submit("a red fox");
    expect(posts("/api/generate")[0]!.raw).toBe('{"prompt":"a red fox","preset":"zz-turbo","size":"zz-square"}');
  });

  it("free edit sends exactly {prompt, preset, resolution, images}", async () => {
    await mount({}, jobs);
    choose("free_edit");
    attach("a.png");
    await submit("make it blue");
    expect(posts("/api/edit")[0]!.raw).toBe(`{"prompt":"make it blue","preset":"zz-turbo","resolution":"zz-res","images":["${b64("PNGDATA")}"]}`);
  });

  it("an edit style sends its id and its two images in slot order", async () => {
    await mount({}, jobs);
    choose("faceswap");
    attach("scene.png", "face.png");
    await submit("");
    expect(posts("/api/edit")[0]!.raw).toBe(
      `{"prompt":"","preset":"zz-turbo","resolution":"zz-res","images":["${b64("PNGDATA")}","${b64("PNGDATA")}"],"style":{"id":"faceswap","params":{}}}`,
    );
  });

  it("upscale sends exactly {image, scale}", async () => {
    await mount({}, jobs);
    choose("upscale");
    attach("a.png");
    q<HTMLFormElement>("#gen-form")!.requestSubmit();
    await flush();
    expect(posts("/api/upscale")[0]!.raw).toBe(`{"image":"${b64("PNGDATA")}","scale":"2x"}`);
  });
});

describe("chaining selects the right entry", () => {
  const GID = `${"b".repeat(31)}1.8199999999101.job-1.0`;
  const resultRoutes: Record<string, Handler> = {
    "POST /api/generate": { status: 202, body: { id: "g-1" } },
    "GET /api/generate/g-1": { body: { status: "done", images: [{ index: 0, url: "/api/image/g-1/0" }], seconds: 1, queued_seconds: null } },
    "GET /api/image/g-1/0": { body: null, raw: "RESULTBYTES", type: "image/png" },
  };
  const chain = (scope: string) => [...document.querySelectorAll<HTMLButtonElement>(`${scope} .chain button`)];

  it("offers one button per edit entry and upscale on a result, and each selects its entry", async () => {
    await mount({}, resultRoutes);
    await submit("a fox");
    await flush();
    expect(chain("#history").map((b) => b.textContent)).toEqual([
      "Use as reference", "Use as reference: Face swap", "Use as reference: Restore old photo", "Upscale",
    ]);
    chain("#history")[1]!.click();
    await flush();
    expect(current()).toEqual(["faceswap"]);
    expect(q("#gen-title")!.textContent).toBe("Face swap");
    expect([...document.querySelectorAll("#ref-list li")].map((li) => li.querySelector(".ref-tag")?.textContent ?? li.textContent)).toEqual([
      "Scene to keep", "Face to use: not attached yet",
    ]);
    expect(window.localStorage.getItem("vast-comfy.tool")).toBe("faceswap");
    chain("#history")[3]!.click();
    await flush();
    expect(current()).toEqual(["upscale"]);
    expect(document.querySelectorAll("#ref-list li")).toHaveLength(1);
    chain("#history")[0]!.click();
    await flush();
    expect(current()).toEqual(["free_edit"]);
  });

  it("does the same from a saved gallery image", async () => {
    await mount({ gallery: true }, {
      "GET /api/gallery": { body: { items: [{ id: GID, url: `/api/gallery/${GID}/image`, created_at: 1_800_000_001, kind: "generate", prompt: "p", label: "l", owner_name: "Ayu", mine: true, size: 10 }], next: null } },
      [`GET /api/gallery/${GID}/image`]: { body: null, raw: "SAVED", type: "image/png" },
    });
    q("#gal-open")!.click();
    await flush();
    const buttons = chain("#gal-list");
    expect(buttons.map((b) => b.textContent)).toEqual(["Use as reference", "Use as reference: Face swap", "Use as reference: Restore old photo", "Upscale"]);
    buttons[2]!.click();
    await flush();
    expect(current()).toEqual(["photo_restore"]);
    expect(q("#ref-list .ref-name")!.textContent).toBe(`saved-${GID.slice(0, 8)}.png`);
  });
});

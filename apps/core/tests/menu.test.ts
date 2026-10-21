import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { DEFAULT_MENU, MENU_ICONS, menuItems, parseMenu } from "../src/menu.js";
import { ProfileError } from "../src/profile-errors.js";
import { loadProfile } from "../src/profile.js";
import { parseStyles } from "../src/styles.js";

// The tool menu: categories and built-in tools come from the profile's `menu:` section, each enabled style adds
// its own entry. Everything is validated at load; the page only ever sees titles, descriptions and icon names.

type Doc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const shippedPath = fileURLToPath(new URL("../../../instance/profiles/image.yaml", import.meta.url));
const shippedRaw = parse(readFileSync(shippedPath, "utf8")) as Doc;

function variant(change: (doc: Doc) => void) {
  const doc = structuredClone(shippedRaw);
  change(doc);
  const path = join(mkdtempSync(join(tmpdir(), "menu-profile-")), "image.yaml");
  writeFileSync(path, stringify(doc));
  return loadProfile(path);
}

/** A valid raw `menu:` section; each test edits a copy. */
function rawMenu(): Doc {
  return {
    categories: [{ id: "create", title: "Create" }, { id: "fix", title: "Edit & fix" }],
    tools: [
      { id: "text_to_image", title: "Text to image", description: "Describe a picture", icon: "image", mode: "generate", category: "create", order: 10 },
      { id: "free_edit", title: "Free edit", icon: "wand", mode: "edit", category: "fix" },
      { id: "upscale", title: "Upscale", icon: "expand", mode: "upscale", category: "fix", order: 5 },
    ],
  };
}

describe("parseMenu", () => {
  it("parses categories and tools in order, with optional description and order", () => {
    const menu = parseMenu(rawMenu());
    expect(menu.categories).toEqual([{ id: "create", title: "Create" }, { id: "fix", title: "Edit & fix" }]);
    expect(menu.tools[0]).toEqual({ id: "text_to_image", title: "Text to image", description: "Describe a picture", icon: "image", mode: "generate", category: "create", order: 10 });
    expect(menu.tools[1]).toMatchObject({ description: null, order: null });
  });

  it("a profile without a menu section gets one category with the three plain tools", () => {
    expect(parseMenu(undefined)).toBe(DEFAULT_MENU);
    expect(parseMenu(null)).toBe(DEFAULT_MENU);
    expect(DEFAULT_MENU.tools.map((t) => t.mode)).toEqual(["generate", "edit", "upscale"]);
    expect(DEFAULT_MENU.categories).toHaveLength(1);
  });

  const bad: [string, (m: Doc) => void, RegExp][] = [
    ["an unknown key", (m) => (m.extra = 1), /menu has unknown keys: extra/],
    ["no categories", (m) => (m.categories = []), /menu categories must be a non-empty list/],
    ["a duplicate category", (m) => m.categories.push({ id: "create", title: "Again" }), /category ids must be unique/],
    ["a bad category id", (m) => (m.categories[0].id = "Create Things"), /category id/],
    ["a category with an unknown key", (m) => (m.categories[0].icon = "image"), /category create has unknown keys: icon/],
    ["a long category title", (m) => (m.categories[0].title = "x".repeat(41)), /category create title/],
    ["no tools list", (m) => (m.tools = "all"), /menu tools must be a list/],
    ["a tool with an unknown key", (m) => (m.tools[0].workflow = "x.json"), /menu tool text_to_image has unknown keys: workflow/],
    ["a duplicate tool id", (m) => m.tools.push({ ...m.tools[0], mode: "edit" }), /tool ids must be unique/],
    ["two tools for one mode", (m) => m.tools.push({ ...m.tools[0], id: "again" }), /only one menu tool per mode: generate/],
    ["an unknown mode", (m) => (m.tools[0].mode = "video"), /mode must be one of generate, edit, upscale/],
    ["an unknown category", (m) => (m.tools[0].category = "nope"), /category 'nope' is not one of the menu categories/],
    ["an icon outside the built-in set", (m) => (m.tools[0].icon = "https-logo"), /icon must be one of/],
    ["a description on two lines", (m) => (m.tools[0].description = "one\ntwo"), /description must be one line/],
    ["a long description", (m) => (m.tools[0].description = "x".repeat(121)), /description must be a non-empty string of at most 120/],
    ["a fractional order", (m) => (m.tools[0].order = 1.5), /order must be a whole number/],
    ["a missing title", (m) => delete m.tools[0].title, /title/],
  ];
  it.each(bad)("refuses %s", (_name, change, message) => {
    const m = rawMenu();
    change(m);
    expect(() => parseMenu(m)).toThrow(ProfileError);
    expect(() => parseMenu(m)).toThrow(message);
  });

  it("the icon set is closed and small", () => {
    expect(MENU_ICONS).toEqual(["image", "wand", "user", "users", "swap", "shirt", "restore", "sparkles", "expand", "camera", "brush"]);
  });
});

describe("menu entries of styles", () => {
  const style = (over: Doc = {}) => ({ id: "anime", title: "Anime", kind: "preset", modes: ["generate"], enabled: true, prompt_template: "anime {prompt}", ...over });

  it("a style may name its category, description, icon and order; they are validated with the style", () => {
    const [st] = parseStyles([style({ category: "create", description: "Clean line art", icon: "sparkles", order: 3 })], []);
    expect(st!.menu).toEqual({ category: "create", description: "Clean line art", icon: "sparkles", order: 3 });
    const [plain] = parseStyles([style()], []);
    expect(plain!.menu).toEqual({ category: null, description: null, icon: null, order: null });
    expect(() => parseStyles([style({ icon: "rocket" })], [])).toThrow(/style anime: icon must be one of/);
    expect(() => parseStyles([style({ description: "a\nb" })], [])).toThrow(/style anime: description must be one line/);
    expect(() => parseStyles([style({ order: "first" })], [])).toThrow(/style anime: order must be a whole number/);
    expect(() => parseStyles([style({ category: "Not An Id" })], [])).toThrow(/style anime: category/);
    // A disabled style is validated the same way.
    expect(() => parseStyles([style({ enabled: false, icon: "rocket" })], [])).toThrow(/icon must be one of/);
  });

  it("places each style after the tools of its category, by order, defaulting to the category and icon of its mode's tool", () => {
    const menu = parseMenu(rawMenu());
    const styles = parseStyles([
      style({ id: "late", title: "Late", category: "create", order: 50 }),
      style({ id: "early", title: "Early", category: "create", order: 1, icon: "user", description: "First" }),
      style({ id: "swapper", title: "Swapper", modes: ["edit"] }),
    ], []);
    const items = menuItems(menu, styles);
    expect(items.map((i) => i.id)).toEqual(["early", "text_to_image", "late", "upscale", "free_edit", "swapper"]);
    expect(items.find((i) => i.id === "early")).toEqual({ id: "early", title: "Early", description: "First", icon: "user", category: "create", tool: "generate", style: "early" });
    // No category and no icon: those of the edit tool; no order: after the ordered entries, in profile order.
    expect(items.find((i) => i.id === "swapper")).toEqual({ id: "swapper", title: "Swapper", description: null, icon: "wand", category: "fix", tool: "edit", style: "swapper" });
  });

  it("a style offered in two modes gets one entry per mode, with ids that cannot clash", () => {
    const styles = parseStyles([style({ id: "both", title: "Both", modes: ["generate", "edit"] })], []);
    const items = menuItems(parseMenu(rawMenu()), styles).filter((i) => i.style === "both");
    expect(items.map((i) => [i.id, i.tool, i.category])).toEqual([["both-generate", "generate", "create"], ["both-edit", "edit", "fix"]]);
  });

  it("a mode without a tool still places its styles (first category, sparkles icon)", () => {
    const menu = parseMenu({ categories: [{ id: "only", title: "Only" }], tools: [{ id: "gen", title: "Generate", icon: "image", mode: "generate", category: "only" }] });
    const [item] = menuItems(menu, parseStyles([style({ id: "fix", title: "Fix", modes: ["edit"] })], [])).filter((i) => i.style !== null);
    expect(item).toMatchObject({ category: "only", icon: "sparkles", tool: "edit" });
  });
});

describe("the menu in a profile", () => {
  it("the shipped profile: three categories, the plain tools and every style in the suggested order", () => {
    const profile = loadProfile(shippedPath);
    expect(profile.menu.categories).toEqual([{ id: "create", title: "Create" }, { id: "edit", title: "Edit & combine" }, { id: "enhance", title: "Enhance" }]);
    const items = menuItems(profile.menu, profile.styles);
    expect(items.map((i) => [i.category, i.title, i.tool, i.style])).toEqual([
      ["create", "Text to image", "generate", null],
      ["create", "Portrait photo", "generate", "portrait_photo"],
      ["create", "Family photo", "generate", "family_photo"],
      ["create", "Anime illustration", "generate", "anime"],
      ["edit", "Free edit", "edit", null],
      ["edit", "Anime / cartoon to real", "edit", "anything2real"],
      ["edit", "Face swap", "edit", "faceswap"],
      ["edit", "Outfit swap", "edit", "outfit_swap"],
      ["edit", "Photo to anime", "edit", "to_anime"],
      ["enhance", "Restore old photo", "edit", "photo_restore"],
      ["enhance", "Upscale", "upscale", null],
    ]);
    for (const i of items) {
      expect(i.description, i.id).toEqual(expect.any(String));
      expect(MENU_ICONS, i.id).toContain(i.icon);
    }
  });

  it("a disabled style has no entry, but its category must still exist", () => {
    const off = variant((d) => (d.styles.find((s: Doc) => s.id === "anime").enabled = false));
    expect(menuItems(off.menu, off.styles).map((i) => i.id)).not.toContain("anime");
    expect(() => variant((d) => Object.assign(d.styles.find((s: Doc) => s.id === "anime"), { enabled: false, category: "gone" }))).toThrow(/style anime: category 'gone' is not one of the menu categories/);
  });

  it("refuses a style whose id is also a tool id", () => {
    expect(() => variant((d) => (d.menu.tools[0].id = "faceswap"))).toThrow(/style faceswap: its id is also the id of a menu tool/);
  });

  it("a profile without a menu section loads with the default menu, and its styles must then use its category", () => {
    const plain = variant((d) => {
      delete d.menu;
      for (const s of d.styles) {
        delete s.category;
        delete s.order;
      }
    });
    expect(plain.menu).toBe(DEFAULT_MENU);
    const items = menuItems(plain.menu, plain.styles);
    expect(items.slice(0, 3).map((i) => i.tool)).toEqual(["generate", "edit", "upscale"]);
    expect(new Set(items.map((i) => i.category))).toEqual(new Set([DEFAULT_MENU.categories[0]!.id]));
    expect(() => variant((d) => delete d.menu)).toThrow(/is not one of the menu categories/);
  });

  it("an edit tool is allowed without an edit section (the API marks it unavailable)", () => {
    const profile = variant((d) => {
      delete d.edit;
      for (const s of d.styles) if (s.modes.includes("edit")) delete s.defaults;
    });
    expect(profile.menu.tools.map((t) => t.mode)).toContain("edit");
  });
});

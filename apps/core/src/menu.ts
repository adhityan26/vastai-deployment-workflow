import { ProfileError } from "./profile-errors.js";
import type { StyleSpec } from "./styles.js";

// The tool menu of the page: ordered categories, the built-in tools (plain generate, plain edit, upscale, video) and one
// entry per enabled style. The profile's `menu:` section declares the categories and the tools; a style may name
// its own category, description, icon and order. Everything is checked at load, and the page only ever receives
// titles, descriptions, icon names and ids (never templates, node ids or file names).

export type ToolMode = "generate" | "edit" | "upscale" | "video";

/** The built-in inline SVG icons the page bundle draws (apps/web/public/icons.ts); nothing is loaded from outside. */
export const MENU_ICONS = ["image", "wand", "user", "users", "swap", "shirt", "restore", "sparkles", "expand", "camera", "brush", "film"] as const;
export type MenuIcon = (typeof MENU_ICONS)[number];

export interface MenuCategory {
  readonly id: string;
  readonly title: string;
}

export interface MenuTool {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly icon: MenuIcon;
  readonly mode: ToolMode;
  readonly category: string;
  /** Position inside its category (lower first); null sorts after every ordered entry, in profile order. */
  readonly order: number | null;
}

export interface MenuSpec {
  readonly categories: readonly MenuCategory[];
  readonly tools: readonly MenuTool[];
}

/** What a style says about its own menu entry; null fields take the values of its mode's tool. */
export interface StyleMenuFields {
  readonly category: string | null;
  readonly description: string | null;
  readonly icon: MenuIcon | null;
  readonly order: number | null;
}

/** One entry of the resolved menu, in display order. */
export interface MenuItem {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly icon: MenuIcon;
  readonly category: string;
  /** Which request the entry sends: /api/generate, /api/edit, /api/upscale or /api/video. */
  readonly tool: ToolMode;
  /** The style the entry selects; null for a built-in tool. */
  readonly style: string | null;
}

// Protocol/safety rules, not configuration.
const ID = /^[a-z][a-z0-9_]{0,31}$/;
const MODES: readonly ToolMode[] = ["generate", "edit", "upscale", "video"];
const CATEGORY_TITLE_MAX = 40;
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 120;
const MENU_KEYS = new Set(["categories", "tools"]);
const CATEGORY_KEYS = new Set(["id", "title"]);
const TOOL_KEYS = new Set(["id", "title", "description", "icon", "mode", "category", "order"]);
/** The icon of a style whose mode has no tool to borrow one from. */
const FALLBACK_ICON: MenuIcon = "sparkles";

/** The menu of a profile without a `menu:` section: one category and the four plain tools. */
export const DEFAULT_MENU: MenuSpec = Object.freeze({
  categories: Object.freeze([{ id: "tools", title: "Tools" }]),
  tools: Object.freeze([
    { id: "generate", title: "Generate", description: null, icon: "image", mode: "generate", category: "tools", order: null },
    { id: "edit", title: "Edit images", description: null, icon: "wand", mode: "edit", category: "tools", order: null },
    { id: "upscale", title: "Upscale", description: null, icon: "expand", mode: "upscale", category: "tools", order: null },
    { id: "video", title: "Video", description: null, icon: "film", mode: "video", category: "tools", order: null },
  ] as MenuTool[]),
});

function mapping(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProfileError(`${what} must be a mapping`);
  return value as Record<string, unknown>;
}

function noUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, what: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length > 0) throw new ProfileError(`${what} has unknown keys: ${unknown.sort().join(", ")}`);
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new ProfileError(`${what} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function id(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new ProfileError(`${what} must be a plain lower-case identifier`);
  return value;
}

function description(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  const d = text(value, `${what} description`, DESCRIPTION_MAX);
  if (/[\r\n]/.test(d)) throw new ProfileError(`${what} description must be one line`);
  return d;
}

function icon(value: unknown, what: string): MenuIcon {
  if (typeof value !== "string" || !(MENU_ICONS as readonly string[]).includes(value)) {
    throw new ProfileError(`${what} icon must be one of ${MENU_ICONS.join(", ")}`);
  }
  return value as MenuIcon;
}

function order(value: unknown, what: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value)) throw new ProfileError(`${what} order must be a whole number`);
  return value as number;
}

/** Parse and validate the profile's `menu:` section; DEFAULT_MENU when it has none. */
export function parseMenu(raw: unknown): MenuSpec {
  if (raw === undefined || raw === null) return DEFAULT_MENU;
  const m = mapping(raw, "menu");
  noUnknownKeys(m, MENU_KEYS, "menu");
  const catsRaw = m["categories"];
  if (!Array.isArray(catsRaw) || catsRaw.length === 0) throw new ProfileError("menu categories must be a non-empty list");
  const categories = catsRaw.map((item) => {
    const c = mapping(item, "menu category");
    const cid = id(c["id"], "menu category id");
    noUnknownKeys(c, CATEGORY_KEYS, `menu category ${cid}`);
    return { id: cid, title: text(c["title"], `menu category ${cid} title`, CATEGORY_TITLE_MAX) };
  });
  if (new Set(categories.map((c) => c.id)).size !== categories.length) throw new ProfileError("menu category ids must be unique");
  const known = categories.map((c) => c.id);

  const toolsRaw = m["tools"] ?? [];
  if (!Array.isArray(toolsRaw)) throw new ProfileError("menu tools must be a list");
  const tools = toolsRaw.map((item): MenuTool => {
    const t = mapping(item, "menu tool");
    const tid = id(t["id"], "menu tool id");
    const what = `menu tool ${tid}`;
    noUnknownKeys(t, TOOL_KEYS, what);
    const mode = t["mode"] as ToolMode;
    if (!MODES.includes(mode)) throw new ProfileError(`${what}: mode must be one of ${MODES.join(", ")}`);
    return {
      id: tid,
      title: text(t["title"], `${what} title`, TITLE_MAX),
      description: description(t["description"], what),
      icon: icon(t["icon"], what),
      mode,
      category: categoryOf(t["category"], known, what),
      order: order(t["order"], what),
    };
  });
  if (new Set(tools.map((t) => t.id)).size !== tools.length) throw new ProfileError("menu tool ids must be unique");
  // A tool has no parameters of its own, so a second tool for the same mode would be the same page twice.
  const twice = MODES.find((mode) => tools.filter((t) => t.mode === mode).length > 1);
  if (twice !== undefined) throw new ProfileError(`only one menu tool per mode: ${twice}`);
  return { categories, tools };
}

function categoryOf(value: unknown, known: readonly string[], what: string): string {
  const c = id(value, `${what} category`);
  if (!known.includes(c)) throw new ProfileError(`${what}: category '${c}' is not one of the menu categories (${known.join(", ")})`);
  return c;
}

/** The menu keys of one raw style (called by the style parser, so a disabled style is checked the same way). */
export function parseStyleMenuFields(s: Record<string, unknown>, styleId: string): StyleMenuFields {
  const what = `style ${styleId}:`;
  return {
    category: s["category"] === undefined ? null : id(s["category"], `style ${styleId}: category`),
    description: description(s["description"], what),
    icon: s["icon"] === undefined ? null : icon(s["icon"], what),
    order: order(s["order"], what),
  };
}

/**
 * Check every raw style (enabled or not) against the menu: a category it names must be one of the menu's (a closed
 * set), and its id must not also be a tool id. Runs after the styles were parsed, so each entry is a valid style.
 */
export function checkStyleMenus(rawStyles: unknown, menu: MenuSpec): void {
  if (!Array.isArray(rawStyles)) return;
  const known = menu.categories.map((c) => c.id);
  const toolIds = new Set(menu.tools.map((t) => t.id));
  for (const item of rawStyles as Record<string, unknown>[]) {
    const sid = String(item["id"]);
    if (item["category"] !== undefined) categoryOf(item["category"], known, `style ${sid}`);
    if (toolIds.has(sid)) throw new ProfileError(`style ${sid}: its id is also the id of a menu tool`);
  }
}

/**
 * The menu in display order: categories in profile order; inside each, entries by `order` (unordered ones last),
 * then tools before styles, each in profile order. A style offered in several modes gets one entry per mode
 * (`<style id>-<mode>`: a hyphen never appears in a tool or style id, so these cannot clash).
 */
export function menuItems(menu: MenuSpec, styles: readonly StyleSpec[]): MenuItem[] {
  const toolOf = (mode: ToolMode): MenuTool | undefined => menu.tools.find((t) => t.mode === mode);
  const entries: { item: MenuItem; order: number | null }[] = menu.tools.map((t) => ({
    item: { id: t.id, title: t.title, description: t.description, icon: t.icon, category: t.category, tool: t.mode, style: null },
    order: t.order,
  }));
  for (const st of styles) {
    for (const mode of st.modes) {
      const tool = toolOf(mode);
      entries.push({
        item: {
          id: st.modes.length === 1 ? st.id : `${st.id}-${mode}`,
          title: st.title,
          description: st.menu.description,
          icon: st.menu.icon ?? tool?.icon ?? FALLBACK_ICON,
          category: st.menu.category ?? tool?.category ?? menu.categories[0]!.id,
          tool: mode,
          style: st.id,
        },
        order: st.menu.order,
      });
    }
  }
  const rank = (o: number | null): number => (o === null ? Number.POSITIVE_INFINITY : o);
  return menu.categories.flatMap((c) =>
    entries
      .map((e, seq) => ({ ...e, seq }))
      .filter((e) => e.item.category === c.id)
      .sort((a, b) => rank(a.order) - rank(b.order) || a.seq - b.seq)
      .map((e) => e.item),
  );
}

// The built-in icons of the tool menu: small inline SVG line drawings (24 x 24, stroked with the text colour).
// The names are the closed set the profile may use (MENU_ICONS in apps/core/src/menu.ts); nothing is loaded from
// outside and no markup is parsed: every node is created with createElementNS.

// The SVG XML namespace name (an identifier, never fetched).
const SVG_NS = "http://www.w3.org/2000/svg"; // config-lint: ok (XML namespace name, not a URL that is fetched)

/** Path data per icon name. */
export const ICONS: Readonly<Record<string, readonly string[]>> = {
  image: ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M17 9a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0"],
  wand: ["M4 20L15 9", "M13 7l4 4", "M18 2.5v3M16.5 4h3", "M20 9.5v2M19 10.5h2", "M9 3.5v2M8 4.5h2"],
  user: ["M12 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8", "M4 21a8 8 0 0 1 16 0"],
  users: ["M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7", "M2 20a7 7 0 0 1 14 0", "M16 4.3a3.5 3.5 0 0 1 0 6.4", "M18 13.6a7 7 0 0 1 4 6.4"],
  swap: ["M4 8h14", "M15 5l3 3-3 3", "M20 16H6", "M9 13l-3 3 3 3"],
  shirt: ["M8 3L3 6l2 5 3-1v11h8V10l3 1 2-5-5-3a4 4 0 0 1-8 0z"],
  restore: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5", "M12 8v4l3 2"],
  sparkles: ["M11 3l1.8 4.9L17.7 9.7l-4.9 1.8L11 16.4l-1.8-4.9L4.3 9.7l4.9-1.8z", "M18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"],
  expand: ["M14 4h6v6", "M20 4l-7 7", "M10 20H4v-6", "M4 20l7-7"],
  camera: ["M3 8h4l2-3h6l2 3h4v12H3z", "M12 17a4 4 0 1 0 0-8a4 4 0 1 0 0 8"],
  brush: ["M19 3l2 2-9 9-2-2z", "M10 12c-3 0-4.5 1.8-4.5 4.2S4.3 19.6 3 20c2.8 1.6 8.4 1.3 9-4.6"],
};

/**
 * Icons of the page's own controls (not offered to the profile, so not part of the menu set above). Also a closed set:
 * a name outside it draws nothing.
 */
export const UI_ICONS: Readonly<Record<string, readonly string[]>> = {
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
};

/** The icon drawn for a name outside the set. */
export const DEFAULT_ICON = "sparkles";

/** A decorative SVG icon (hidden from assistive technology: the entry's title says what it is). */
export function iconNode(doc: Document, name: string): SVGSVGElement {
  return svgNode(doc, Object.hasOwn(ICONS, name) ? ICONS[name]! : ICONS[DEFAULT_ICON]!);
}

/** A decorative icon of a page control (its button carries the text or label). */
export function uiIconNode(doc: Document, name: string): SVGSVGElement {
  return svgNode(doc, Object.hasOwn(UI_ICONS, name) ? UI_ICONS[name]! : []);
}

function svgNode(doc: Document, paths: readonly string[]): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "icon");
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

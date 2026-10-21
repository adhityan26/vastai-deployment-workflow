# Server panel, header credit, floating widget, boot log dialog (approved design)

Status: design approved by the owner on 2026-10-21 after a prototype review (Opus and Fable each proposed, then critiqued
the other). Implementation follows this file. The prototype (static, for the look and the behaviour) is
`docs/superpowers/plans/2026-10-21-server-panel-prototype.html` when it was added by the implementer; otherwise ask the owner.

## Goal
Move the server status and run controls out of the middle column into a RIGHT PANEL, put the Vast credit in the page
HEADER, show a FLOATING widget (uptime, cost so far, idle shutdown) when the panel is not on screen, and move the verbose boot
log out of the main column into a full-screen dialog. Admins reach Start/Extend/Destroy without scrolling past the tool panel.

## Decisions (all approved)

### Layout
- `>= 1280 px`: three columns `250px | minmax(0, 48rem) | 288px`. Left sidebar unchanged (fixed). Right `<aside id="status-panel">`
  is sticky, `max-height` = viewport minus header, own scroll; the Danger zone is pinned at the panel bottom (always visible). The header
  is sticky across the middle and right columns. A "Hide" button collapses the panel; collapsed state is remembered.
- `900-1279 px`: no room for three columns. The panel is a RIGHT DRAWER `min(22rem, 92vw)` opened from the header status pill or the widget.
  It behaves like the existing menu drawer: backdrop, `#page` (and the widget) `inert`, focus trap, Esc closes, focus returns to the opener.
  The drawer is outside `#page`, a sibling of `#tool-nav`.
- `< 900 px`: the existing sticky top bar is the header: `[Menu] title ... [pill] [Logout icon]`. The panel is the same right drawer. The admin's
  credit is the FIRST line inside the drawer below 600 px, a header pill at `>= 600 px`.
- One overlay at a time: replace `setDrawer` by a shared `setOverlay(kind | null)` with kinds `menu | panel | log`. Opening one closes the other.
- z-index scale: header 10, widget 12, backdrop 15, drawers 20, log dialog 25, confirm modal 30 (today the modal is 10).
- Remember: `prefers-reduced-motion` kills slide/number transitions; 44 px targets; no horizontal scroll at 375 px; textContent only.

### Panel content (top to bottom), `<aside aria-labelledby="status-title">`
1. State line `#state-line` (keeps `aria-live="polite"`, the ONLY live region of the panel; guard so the same text is not re-set).
2. Alerts and progress (`#alert-*`, `#progress-box`, boot sentence), failure reason first when failed / destroy failed.
3. Three key figures, large, `tabular-nums`: uptime, cost so far, idle shutdown in (idle highlighted warn tone in idle-warning).
4. Primary action (admin): Start (none), Extend (idle-warning = primary; otherwise a closed `<details>` with kind + minutes), nothing while stopping.
5. Boot summary (admin only, while the console is relevant): the boot STEPPER `#console-steps`, `#boot-sentence`, `#console-ended`, and ONE
   button `#console-open` "View log" (`aria-haspopup="dialog"`, 44 px).
6. Detail facts (smaller `dl`): price, GPU, server, failsafe, hard cap, queue, VRAM.
7. DANGER ZONE section (admin only), its own section with a heading, pinned at the bottom of the panel: "Destroy instance..." (relabelled
   "Destroy instance (retry)" on destroy_failed / failed) and the untracked-instances list (`<details>`, drawn by the existing `renderUnknown`).
   Destroy is never in the header or the widget and never next to Extend. The confirm dialog gets the cost so far; Cancel has the default focus.
- Member: state line, progress/alerts, key figures, facts and the widget; no credit, no actions, no boot summary, no danger zone.
- All existing element ids stay (`f-uptime f-cost f-price f-gpu f-idle f-failsafe f-hardcap f-queue f-vram f-credit-box f-credit state-line
  progress-box alert-* admin-panel btn-start btn-extend btn-destroy extend-kind extend-minutes btn-logout user-name role`); the elements MOVE.
  `render()`, `renderStatus()`, `renderClock()`, polling and `refreshCredit()` stay as they are (renderClock also fills the widget and the pill).

### Header
- Title `h1`; status pill = `<button aria-controls="status-panel" aria-expanded>` with a tone dot and a short label ("Ready", "Booting 42%", "Idle 3m",
  "Stopped", "Failed"). At `>= 1280` with the panel visible it scrolls to / focuses the panel; otherwise it opens the drawer.
- Credit (admin only) keeps `#f-credit-box` / `#f-credit`. Tone via a pure `creditTone(credit, dph)`: bad when `credit <= 0`; warn when
  `credit < max(1, 2 * (dph ?? 0))` (about two hours at the current price, or under $1 with no price); neutral "unavailable" stays neutral; always
  text as well as colour ("$1.10 low").
- Name + Logout inline at `>= 600 px`; below it the name is dropped and Logout is a 44 px icon button with `aria-label`. NO user-menu popover.
- The Start dialog (`onStart`) shows a warning line when the credit is known and `credit < estimate.max_cost`.

### Floating widget `#float-status`
- One `<button aria-controls="status-panel">` bottom-right: `bottom: calc(12px + env(safe-area-inset-bottom))`, right 12px, min 44 px high,
  `max-width: calc(100vw - 24px)`; cells uptime, cost, idle (idle left out when null); below 480 px one compact pill.
- Shown iff the panel is not on screen (collapsed at >= 1280, or any width below 1280 with the drawer closed) AND `uptime_s !== null`, and no
  overlay (drawer, log, confirm modal) is open. Members see it too. It is NOT hidden for the phone keyboard and has NO IntersectionObserver.
  `main` gets bottom padding = widget height + 24 px while it shows.
- The ticking numbers are `aria-hidden="true"`; the button has a fixed accessible name ("Server status, open panel"). It is never a live region.
- Activating it opens the drawer, or expands the panel at >= 1280, and moves focus to `#status-title` (`tabindex="-1"`).

### Remembered state
- `vast-comfy.panel` = `"open"` | `"collapsed"`; any other value means open; read/write in try/catch like `TOOL_STORAGE_KEY`; applied ONLY at >= 1280;
  drawers always start closed.

### Boot log dialog
- `#console-card` becomes a full-screen DIALOG (`role="dialog"`, `aria-modal`, `aria-labelledby="console-title"`), opened by `#console-open`, z-index 25.
  Desktop/tablet: large centred dialog; phone: `100dvh` with the log `flex: 1` and the actions in a bottom row above the safe-area inset.
- Inside: `#console-log`, `#console-actions` (`console-pause console-copy console-clear console-download`), `#console-status`, `#console-note`,
  `#console-error`, `#console-ended` copy as needed. `#console-steps`, `#boot-sentence` and `#console-ended` live in the PANEL summary instead.
- Open/close/Esc/backdrop; focus returns to `#console-open` (or to the header pill on phone when opened from the drawer: opening it closes the drawer).
  Removed: `#console-toggle` and `CONSOLE_COLLAPSED_KEY`. Polling (`scheduleConsole`/`kickConsole`) is UNCHANGED and keeps running while the admin
  page is open, because the panel summary needs the payload even when the dialog is closed.

### Not in scope
Server/API changes (none needed), the Start dialog's advanced server choice (already on master), the tool menu structure, new config keys.

## TDD order
1. `model.test`: `creditTone`, `layoutMode(width)` (pure; jsdom has no layout), `panelPref` (parse/validate), `pillView(state, progress, idle)`, widget visibility predicate.
2. Page test: ids exist inside `aside#status-panel`, exactly ONE `aria-live` region for status. Then move the markup. Whole suite stays green (fix `menu.test.ts`
   order assertions and the console collapse tests deliberately).
3. Header pill + credit tone + Logout (member sees no credit; logout still works; `auth-page.test.ts` keeps `#btn-logout`).
4. Drawer: open/Esc/backdrop/focus return/exclusivity with the menu drawer/`inert`/trap; z-index of the confirm modal above the drawer.
5. Widget: shown/hidden by state and overlays, members, fixed name, ticking text, no live region.
6. Collapse remembered (valid, invalid, throwing localStorage).
7. Log dialog: open/close/Esc/focus return, panel summary shows stepper + sentence, polling unchanged, member sees none of it.
8. Start dialog credit warning.
9. CSS assertions that jsdom can make (widths, reduced motion), README "Menu"/"Boot console"/"Vast credit" sections and HANDOFF updated.
Mutation-check the security/behaviour-critical parts (textContent, stored value validation, focus trap, inert, overlay exclusivity, credit tone).

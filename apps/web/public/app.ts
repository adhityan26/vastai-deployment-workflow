import { mountApp } from "./ui.js";

mountApp(document, {
  fetch: (input, init) => window.fetch(input, init),
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h as number),
});

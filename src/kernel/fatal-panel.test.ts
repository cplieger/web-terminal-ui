// The fatal-startup panel as the browser actually lays it out, with the shipped
// stylesheet loaded.
//
// It exists for one class of silent breakage. The panel is a native <dialog>, so
// the UA sheet gives it a fit-content, auto-margined, bordered box and caps a
// :modal one at calc(100% - 38px) in both axes — measured in Blink as a 96x59
// centred card where this panel is a full-surface replacement for the terminal.
// css/10-primitives.css undoes each of those, and every one of those
// declarations can be deleted without failing any other test in the suite: the
// kernel's own tests build no stylesheet, so a rect there is UA geometry either
// way.
//
// The second sheet that reaches a <dialog> is the EMBEDDER's, and it is the one
// no amount of reading our own CSS reveals: a host page's generic `dialog { … }`
// base rule wins every property the package's own rule omits. That needs a host
// stylesheet in the page to measure, which is also only possible here.
//
// It is also the only place the top-layer claim is checked. showModal() paints
// the panel outside every ancestor's paint context, and this package scopes
// every rule `:where(.wt-root) …` — so "the scoped rules still match a promoted
// dialog" is an assumption until something measures it.
//
// The panel is driven through the REAL production path (a synchronous
// createTerminal failure), not hand-built markup: the multiple-session-owner
// guard throws before any DOM or engine work, so the kernel renders its panel
// with nothing mocked.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createTerminal } from "./kernel.js";
import type { TerminalFeature } from "./types.js";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

// Same shape as features/tabs/chip-geometry.test.ts, and deliberately repeated
// rather than shared: a test-support module would need a matching exclude in
// BOTH publish allowlists (package.json `files` and jsr.json
// `publish.exclude`), and the standing rule there is to carry only patterns that
// match something.
const MANIFESTS = import.meta.glob("../../css/MANIFEST*", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SHEETS = import.meta.glob("../../css/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const byName = (mods: Record<string, string>): Map<string | undefined, string> =>
  new Map(Object.entries(mods).map(([p, text]) => [p.split("/").pop(), text]));

// The FULL-PAGE manifest, because wt-viewport is the full-page product's layout
// mode. The manifest order IS the cascade, so it is read rather than restated.
const BUNDLE = ((): string => {
  const manifest = byName(MANIFESTS).get("MANIFEST");
  if (manifest === undefined) {
    throw new Error("css/MANIFEST is missing");
  }
  const sheets = byName(SHEETS);
  return manifest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((name) => {
      const text = sheets.get(name);
      if (text === undefined) {
        throw new Error(`css/MANIFEST names ${name}, which css/ does not contain`);
      }
      return text;
    })
    .join("\n");
})();

let styles: HTMLStyleElement;
const mounted: HTMLElement[] = [];

beforeAll(() => {
  styles = document.createElement("style");
  styles.textContent = BUNDLE;
  document.head.appendChild(styles);
});
afterAll(() => {
  styles.remove();
});
afterEach(() => {
  // Load-bearing, and the exposure is the NEXT TEST IN THIS FILE rather than the
  // next file: browser-mode isolation is per file, so nothing here can leak
  // across one. Unlike kernel.test.ts this file has no beforeEach that clears
  // the body, so a modal panel left in the top layer would inert the page for
  // every test after it — including the container ones, whose whole subject is
  // that nothing is inerted.
  for (const el of mounted.splice(0)) {
    el.remove();
  }
});

/** The one synchronous throw the kernel raises itself, and it fires before any
 *  DOM or engine work — which is what makes it usable here with nothing mocked. */
const twoOwners = (): TerminalFeature[] =>
  ["a", "b"].map((name) => ({
    name,
    sessionOwner: { resolveInitialSession: () => Promise.resolve(null) },
    setup() {
      return { teardown: () => undefined };
    },
  }));

/** Mount a root and drive the kernel into its fatal panel. Returns the panel. */
function fatalPanel(layout: "viewport" | "container", host?: HTMLElement): HTMLDialogElement {
  const root = document.createElement("div");
  (host ?? document.body).appendChild(root);
  mounted.push(host ?? root);
  expect(() => createTerminal(root, { features: twoOwners, layout })).toThrow();
  const panel = root.querySelector<HTMLDialogElement>("dialog.wt-fatal");
  if (!panel) {
    throw new Error("the kernel rendered no fatal panel");
  }
  return panel;
}

describe("the fatal panel's box, with the shipped stylesheet loaded", () => {
  it("fills the viewport when modal, so the UA's capped fit-content box is gone", () => {
    const panel = fatalPanel("viewport");
    expect(panel.matches(":modal")).toBe(true);

    const rect = panel.getBoundingClientRect();
    expect(rect.left).toBe(0);
    expect(rect.top).toBe(0);
    expect(rect.width).toBe(window.innerWidth);
    expect(rect.height).toBe(window.innerHeight);

    // The three UA defaults that each shrink it, all red-checked by deleting the
    // declaration that undoes them: the fit-content sizing, the :modal max-* cap,
    // and the 3px border. The base rule's `margin: 0` is NOT among them, because
    // against the UA sheet alone it changes no box — what it does guard is a host
    // page's own rule, which the next test measures.
    const cs = getComputedStyle(panel);
    expect(cs.width).toBe(`${String(window.innerWidth)}px`);
    expect(cs.maxWidth).toBe("none");
    expect(cs.maxHeight).toBe("none");
    expect(cs.borderTopWidth).toBe("0px");
  });

  it("refuses a host page's own generic dialog base rule", () => {
    // The panel is a <dialog> now, so an embedder's unlayered `dialog { ... }`
    // base rule reaches it where a <section> was never a plausible target. At
    // (0,0,1) it cedes every property the (0,1,0) base rule declares and wins
    // every one it omits, so the panel is only safe for the properties that rule
    // actually names. `margin` is the member that moves the box: 2rem insets a
    // full-surface panel inside its own root.
    const hostSheet = document.createElement("style");
    hostSheet.textContent = "dialog { margin: 2rem; border-radius: 8px; box-shadow: 0 0 4px #000 }";
    document.head.appendChild(hostSheet);
    try {
      const panel = fatalPanel("viewport");
      const rect = panel.getBoundingClientRect();
      expect(rect.left).toBe(0);
      expect(rect.top).toBe(0);
      expect(rect.width).toBe(window.innerWidth);
      expect(rect.height).toBe(window.innerHeight);

      const cs = getComputedStyle(panel);
      expect(cs.marginTop).toBe("0px");
      expect(cs.borderTopLeftRadius).toBe("0px");
      expect(cs.boxShadow).toBe("none");
    } finally {
      hostSheet.remove();
    }
  });

  it("stays pinned to the viewport when the host document is scrolled", () => {
    // A top-layer element resolves an absolute position against the INITIAL
    // containing block, which is viewport-SIZED but canvas-anchored — so the
    // base rule's `position: absolute` equals the UA's `dialog:modal
    // { position: fixed }` at scrollY 0 and nowhere else. Blink does not lock
    // document scrolling under a modal, so the divergence is reachable rather
    // than theoretical, and it takes the whole panel off screen.
    //
    // The host that reaches it is one that never loaded the page kit (an
    // embedder passing layout: "viewport", and the kernel's own fallback host,
    // which appends a .wt-root.wt-viewport to whatever document it finds).
    // page.css's `html, body { overflow: hidden; height: 100% }` is in this
    // file's bundle, so its ABSENCE is reproduced at the site by restoring both
    // properties to their initial values rather than assumed.
    const noPageKit = document.createElement("style");
    noPageKit.textContent = "html, body { overflow: visible; height: auto }";
    document.head.appendChild(noPageKit);
    const spacer = document.createElement("div");
    spacer.style.cssText = "height: 3000px";
    document.body.appendChild(spacer);
    try {
      const panel = fatalPanel("viewport");
      expect(panel.matches(":modal")).toBe(true);
      window.scrollTo(0, 900);
      // The document really did move, or the assertion below proves nothing.
      expect(window.scrollY).toBe(900);

      const rect = panel.getBoundingClientRect();
      expect(rect.top).toBe(0);
      expect(rect.left).toBe(0);
      expect(rect.height).toBe(window.innerHeight);
    } finally {
      window.scrollTo(0, 0);
      spacer.remove();
      noPageKit.remove();
    }
  });

  it("keeps the package's :where(.wt-root) rules once promoted to the top layer", () => {
    // A promoted dialog is painted outside every ancestor's paint context, but it
    // does not MOVE in the DOM — so the scoped selectors still match, and this is
    // what says so rather than assuming it. Without them the panel renders as
    // unstyled UA chrome exactly when it matters most.
    const panel = fatalPanel("viewport");
    expect(panel.closest(".wt-root")).not.toBeNull();
    expect(panel.matches(":where(.wt-root) .wt-fatal")).toBe(true);

    const cs = getComputedStyle(panel);
    expect(cs.display).toBe("grid");
    expect(cs.textAlign).toBe("center");
    // --bg comes from 00-tokens.css, declared on .wt-root.
    expect(cs.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    const card = panel.querySelector(".wt-fatal-card");
    expect(card).not.toBeNull();
    expect(getComputedStyle(card!).borderTopWidth).toBe("1px");
  });

  it("paints the backdrop in the panel's own background, not the UA's dim", () => {
    // The panel IS the dim, so a second differently-coloured layer under it would
    // show as a lighter seam the moment anything makes the panel smaller than the
    // viewport. The UA default is rgba(0, 0, 0, 0.1).
    const panel = fatalPanel("viewport");
    const backdrop = getComputedStyle(panel, "::backdrop").backgroundColor;
    expect(backdrop).toBe(getComputedStyle(panel).backgroundColor);
    expect(backdrop).not.toBe("rgba(0, 0, 0, 0.1)");
  });

  it("fills only its own root when non-modal, leaving the host page's box alone", () => {
    // The embedded case: no top layer, so the panel positions against
    // .wt-root.wt-container and the application around it is untouched.
    const host = document.createElement("div");
    host.style.cssText = "position: absolute; left: 40px; top: 30px; width: 300px; height: 200px";
    document.body.appendChild(host);
    const panel = fatalPanel("container", host);

    expect(panel.open).toBe(true);
    expect(panel.matches(":modal")).toBe(false);
    const rect = panel.getBoundingClientRect();
    expect(rect.left).toBe(40);
    expect(rect.top).toBe(30);
    expect(rect.width).toBe(300);
    expect(rect.height).toBe(200);
    // Not the viewport, which is what a showModal() here would have produced.
    expect(rect.width).toBeLessThan(window.innerWidth);
  });
});

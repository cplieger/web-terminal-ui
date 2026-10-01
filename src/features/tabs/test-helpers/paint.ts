import type {} from "@vitest/browser-playwright";
import { cdp } from "vitest/browser";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

const MANIFESTS = import.meta.glob("../../../../css/MANIFEST*", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SHEETS = import.meta.glob("../../../../css/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const byName = (mods: Record<string, string>): Map<string | undefined, string> =>
  new Map(Object.entries(mods).map(([p, text]) => [p.split("/").pop(), text]));

/** The tabbed preset's stylesheet as css/MANIFEST.tabbed concatenates it. */
const TABBED_BUNDLE = ((): string => {
  const manifest = byName(MANIFESTS).get("MANIFEST.tabbed");
  if (manifest === undefined) {
    throw new Error("css/MANIFEST.tabbed is missing");
  }
  const sheets = byName(SHEETS);
  return manifest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((name) => {
      const text = sheets.get(name);
      if (text === undefined) {
        throw new Error(`css/MANIFEST.tabbed names ${name}, which css/ does not contain`);
      }
      return text;
    })
    .join("\n");
})();

/** A `<style>` holding the tabbed bundle, appended to the document's head. */
export function tabbedStylesheet(): HTMLStyleElement {
  const styles = document.createElement("style");
  styles.textContent = TABBED_BUNDLE;
  document.head.appendChild(styles);
  return styles;
}

// An emulated DSF change can leave this frame's parsed sheet on the previous
// ratio's media results while matchMedia already answers the new one
// (measured: the 1.25 dppx rule still applied at 1.5), so the sheet is
// re-inserted after every change, which evaluates it afresh.
export async function emulateDeviceScale(dpr: number, styles: HTMLStyleElement): Promise<void> {
  await cdp().send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 900,
    deviceScaleFactor: dpr,
    mobile: false,
  });
  document.head.appendChild(styles);
}
export async function clearDeviceScale(styles: HTMLStyleElement): Promise<void> {
  await cdp().send("Emulation.clearDeviceMetricsOverride");
  document.head.appendChild(styles);
}

export function splitIcon(root: HTMLElement, button = ".wt-tab-split"): SVGSVGElement {
  const icon = root.querySelector<SVGSVGElement>(`${button} > svg`);
  if (!icon) {
    throw new Error(`no ${button} icon`);
  }
  return icon;
}
export function iconShapes(icon: SVGSVGElement): SVGRectElement[] {
  return [...icon.querySelectorAll("rect")];
}
// To 1/1000 of a device pixel: a whole pixel reads as an integer, a fraction stays visible.
const toDevice = (n: number): number => Math.round(n * devicePixelRatio * 1000) / 1000;
export function deviceBox(icon: SVGSVGElement): number[] {
  const frame = window.frameElement?.getBoundingClientRect();
  const box = icon.getBoundingClientRect();
  return [(frame?.left ?? 0) + box.left, (frame?.top ?? 0) + box.top, box.width, box.height].map(
    toDevice,
  );
}
export function deviceEdges(icon: SVGSVGElement): { across: number[]; down: number[] } {
  const scale = icon.getBoundingClientRect().width / icon.viewBox.baseVal.width;
  const boxes = iconShapes(icon).map((r) => r.getBBox());
  return {
    across: boxes.flatMap((b) => [toDevice(b.x * scale), toDevice((b.x + b.width) * scale)]),
    down: boxes.flatMap((b) => [toDevice(b.y * scale), toDevice((b.y + b.height) * scale)]),
  };
}

/** Each icon shape's edges from the svg's origin, in device px, per ratio. */
export const ICON_GRIDS = [
  { dpr: 1, across: [1, 7, 9, 11, 13, 19], down: [4, 16, 2, 18, 4, 16] },
  { dpr: 1.25, across: [1, 9, 11, 14, 16, 24], down: [5, 20, 2, 23, 5, 20] },
  { dpr: 1.5, across: [2, 11, 14, 16, 19, 28], down: [6, 24, 3, 27, 6, 24] },
  { dpr: 2, across: [2, 14, 18, 22, 26, 38], down: [8, 32, 4, 36, 8, 32] },
];

export interface SoftKeyboard {
  open(px: number): void;
  scroll(top: number): void;
  restore(): void;
}
// A visual viewport a soft keyboard shrinks while the layout viewport keeps its
// height, which is how iOS Safari reports one.
export function softKeyboard(): SoftKeyboard {
  let inset = 0;
  let top = 0;
  const vv = new (class extends EventTarget {
    get width(): number {
      return window.innerWidth;
    }
    get height(): number {
      return window.innerHeight - inset - top;
    }
    get offsetTop(): number {
      return top;
    }
    readonly offsetLeft = 0;
    readonly pageTop = 0;
    readonly pageLeft = 0;
    readonly scale = 1;
  })();
  const saved = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  return {
    open(px) {
      inset = px;
      vv.dispatchEvent(new Event("resize"));
    },
    scroll(px) {
      top = px;
      vv.dispatchEvent(new Event("scroll"));
    },
    restore() {
      if (saved) {
        Object.defineProperty(window, "visualViewport", saved);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    },
  };
}

/** Hides the window's visual viewport, as a browser without the API has none;
 *  returns the restore. */
export function withoutVisualViewport(): () => void {
  const saved = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  return () => {
    if (saved) {
      Object.defineProperty(window, "visualViewport", saved);
    } else {
      Reflect.deleteProperty(window, "visualViewport");
    }
  };
}

export function switcherBar(root: HTMLElement): HTMLElement {
  const bar = root.querySelector<HTMLElement>(".wt-switcher-bar");
  if (!bar) {
    throw new Error("no switcher bar");
  }
  return bar;
}
export function termOf(paneRootEl: HTMLElement): HTMLElement {
  const term = paneRootEl.querySelector<HTMLElement>(":scope > .term");
  if (!term) {
    throw new Error("no term");
  }
  return term;
}
/** An element's top and bottom edge, in the frame's CSS px. */
export const span = (el: HTMLElement): [number, number] => {
  const r = el.getBoundingClientRect();
  return [r.top, r.bottom];
};

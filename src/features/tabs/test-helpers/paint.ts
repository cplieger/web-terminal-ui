declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

// Vite reads import.meta.glob's arguments statically, so this module must stay
// outside Stryker's `mutate` set: an instrumented options object makes Vite's
// dependency pre-scan fail for the whole browser project.
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

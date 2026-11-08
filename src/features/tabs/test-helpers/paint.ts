import { shippedBundle } from "../../../test-helpers/stylesheet.js";

/** A `<style>` holding the tabbed bundle, appended to the document's head. */
export function tabbedStylesheet(): HTMLStyleElement {
  const styles = document.createElement("style");
  styles.textContent = shippedBundle("MANIFEST.tabbed");
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

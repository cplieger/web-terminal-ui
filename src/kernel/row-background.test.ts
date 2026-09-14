// The cell background as the browser lays it out, with the shipped stylesheet
// loaded. An inline run paints its FONT's content area, never the row's line
// box, so a face shorter than the 17px cell leaves a 1px stripe at every row
// boundary; css/02-terminal.css closes it with padding-block on the runs, and
// this is the only place that padded box is rendered and measured. Geometry,
// not pixels: the box overhangs the text's own content area, meets the next
// row's, and the row stays 17px (the engine sizes the PTY from it). The face is
// the machine's `monospace`, since this package ships none; hence the text box.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

// Same shape as fatal-panel.test.ts, and deliberately repeated rather than
// shared: a test-support module would need a matching exclude in BOTH publish
// allowlists (package.json `files` and jsr.json `publish.exclude`), and the
// standing rule there is to carry only patterns that match something.
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

// The FULL-PAGE manifest: the same bundle the full-page product serves, in the
// order that IS the cascade.
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
let host: HTMLElement | undefined;

beforeAll(() => {
  styles = document.createElement("style");
  styles.textContent = BUNDLE;
  document.head.appendChild(styles);
});
afterAll(() => {
  styles.remove();
});
afterEach(() => {
  host?.remove();
  host = undefined;
});

/** The three run shapes render.ts emits inside a row, each with the background
 *  on the element the engine actually paints it on: a plain styled span; the
 *  autolink anchor, which COPIES the span's inline style onto itself; and the
 *  OSC 8 anchor, which wraps the styled spans and carries no style of its own. */
const RUNS = [
  { name: "a plain run span", html: `<span class="bg" style="background:#0a0">  </span>` },
  {
    name: "an autolink anchor carrying the run's style",
    html: `<a class="term-link term-autolink bg" style="background:#0a0" href="https://x.test/">https://x.test/</a>`,
  },
  {
    name: "a run span inside an OSC 8 anchor",
    html: `<a class="term-link" href="https://x.test/"><span class="bg" style="background:#0a0">  </span></a>`,
  },
] as const;

/** Two adjacent rows in a real .term, each carrying one run of `runHTML`. The
 *  host is sized so wt-container has something to fill; the rows are the
 *  engine's own markup (render.ts), not a stand-in. */
function mountRows(runHTML: string): { rows: HTMLElement[]; painted: HTMLElement[] } {
  host = document.createElement("div");
  host.style.cssText = "width:320px;height:120px";
  host.innerHTML = `<div class="wt-root wt-container"><div class="term"><div class="term-output">
    <div class="term-row" data-abs="0">${runHTML}<span>after</span></div>
    <div class="term-row" data-abs="1">${runHTML}<span>after</span></div>
  </div></div></div>`;
  document.body.appendChild(host);
  const rows = [...host.querySelectorAll<HTMLElement>(".term-row")];
  const painted = [...host.querySelectorAll<HTMLElement>(".bg")];
  expect(rows).toHaveLength(2);
  expect(painted).toHaveLength(2);
  return { rows, painted };
}

/** The box of the element's own text: a Range over its contents reports the
 *  font's content area, which is exactly what an inline background painted
 *  WITHOUT padding would cover. */
function textBox(el: HTMLElement): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect();
}

describe("the run background, with the shipped stylesheet loaded", () => {
  it.each(RUNS)("keeps both rows at the 17px cell with $name in them", ({ html }) => {
    // Padding on an inline non-replaced box extends its painted area and has no
    // effect on line-height (CSS 2.1 §10.6.1); a row that grew resizes the PTY.
    const { rows } = mountRows(html);
    for (const row of rows) {
      expect(row.getBoundingClientRect().height).toBe(17);
    }
  });

  it.each(RUNS)("paints $name past its own content area on both edges", ({ html }) => {
    const { painted } = mountRows(html);
    for (const el of painted) {
      const box = el.getBoundingClientRect();
      const text = textBox(el);
      expect(text.height, "the run has a text box to overhang").toBeGreaterThan(0);
      expect(box.top).toBeLessThanOrEqual(text.top - 1);
      expect(box.bottom).toBeGreaterThanOrEqual(text.bottom + 1);
      // The bundled face's content area is 16px in the 17px row; any fallback
      // whose area is at least that lands at 18 or more once padded.
      expect(box.height).toBeGreaterThanOrEqual(18);
    }
  });

  it.each(RUNS)("makes $name's background meet the next row's", ({ html }) => {
    // The seam itself: the second row's painted box starts no lower than the
    // first's ends, so a gutter drawn down both rows is one unbroken column.
    const { painted } = mountRows(html);
    const [first, second] = painted;
    expect(second!.getBoundingClientRect().top).toBeLessThanOrEqual(
      first!.getBoundingClientRect().bottom,
    );
  });
});

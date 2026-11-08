// The terminal's scrollport as a consumer's box lays it out, with the shipped
// stylesheet, the real renderer, the real scroll controller and the pane's own
// viewport. Following the output, the scrollport shows whole rows: a box whose
// height is not a whole number of 17px rows leaves no partial history row at its
// top edge, and the 4px band above the first row stays.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { LineStore } from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import { shortenSettle, shortSettled } from "../test-helpers/delays.js";
import type { TerminalContext, TerminalFeature } from "./types.js";
import { shippedBundle } from "../test-helpers/stylesheet.js";

const BUNDLE = shippedBundle("MANIFEST");

/** The cell height and the band above and below the rows, as 02-terminal.css
 *  ships them. */
const CELL = 17;
const BAND = 4;

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

function lines(n: number): LineStore {
  const store = new LineStore();
  store.applyScroll({
    type: "scroll",
    firstIndex: 0,
    lines: Array.from({ length: n }, (_, i) => [
      { t: `line-${String(i)}`, f: -1, b: -1, a: 0, uc: -1 },
    ]),
  });
  return store;
}

const frame = (): Promise<void> =>
  new Promise((r) => {
    requestAnimationFrame(() => {
      r();
    });
  });

/** A container terminal in a `height`px box, its pane empty (no socket), showing
 *  `store` and following it. */
async function showing(
  height: number,
  store: LineStore,
): Promise<{ ctx: TerminalContext; term: HTMLElement }> {
  host = document.createElement("div");
  host.style.position = "relative";
  host.style.width = "400px";
  host.style.height = `${String(height)}px`;
  const root = document.createElement("div");
  host.appendChild(root);
  document.body.appendChild(host);
  let captured: TerminalContext | undefined;
  const probe: TerminalFeature<void> = {
    name: "scrollport-probe",
    sessionOwner: { resolveInitialSession: () => Promise.resolve(null) },
    setup(ctx) {
      captured = ctx;
      return { teardown: () => undefined };
    },
  };
  await shortenSettle();
  await mountTerminal(root, { layout: "container", features: () => [probe] });
  if (captured === undefined) {
    throw new Error("the probe feature never ran");
  }
  const ctx = captured;
  ctx.render.bind(store);
  for (let i = 0; i < 60 && ctx.render.pendingRowCount() > 0; i++) {
    await frame();
  }
  await shortSettled();
  ctx.scroll.scrollToBottom();
  await frame();
  await frame();
  return { ctx, term: ctx.surface() };
}

/** Where the first row the scrollport shows any of starts, against the term's
 *  border box top, in px; and where the last one ends against its bottom. The
 *  scrollport is the padding box, which clips what scrolls past its edges. */
function rowEdges(term: HTMLElement): { top: number; bottom: number } {
  const box = term.getBoundingClientRect();
  const portTop = box.top + term.clientTop;
  const portBottom = portTop + term.clientHeight;
  const rows = [...term.querySelectorAll<HTMLElement>(".term-output > *")]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.height > 0 && r.bottom > portTop + 0.5 && r.top < portBottom - 0.5);
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("the scrollport shows no row");
  }
  return { top: first.top - box.top, bottom: box.bottom - last.bottom };
}

describe("the scrollport a box of any height shows", () => {
  // One height per remainder of (height - 2 bands) over the cell, 0 to 16.
  const heights = Array.from({ length: CELL }, (_, i) => 2 * BAND + 12 * CELL + i);

  it.each(heights)("shows whole rows under a 4px band when following, at %ipx", async (height) => {
    const { ctx, term } = await showing(height, lines(120));

    const edges = rowEdges(term);
    expect(edges.top).toBeCloseTo(BAND, 0);
    expect(edges.bottom).toBeGreaterThanOrEqual(BAND - 0.5);
    expect(ctx.render.computeSize().rows).toBe(Math.floor((height - 2 * BAND) / CELL));
  });

  // Display scaling, zoom and %-sized panels give a box a fractional height; the
  // engine counts rows from the integer clientHeight, so the fill must too.
  it.each([210.25, 210.4, 210.6, 221.3, 300.33])(
    "keeps the row count and the band at a fractional %fpx",
    async (height) => {
      const { ctx, term } = await showing(height, lines(120));

      expect(rowEdges(term).top).toBeCloseTo(BAND, 0);
      expect(ctx.render.computeSize().rows).toBe(Math.floor((height - 2 * BAND) / CELL));
    },
  );

  it("shows whole rows again after a scroll up and back to the bottom", async () => {
    const { ctx, term } = await showing(210, lines(120));

    term.scrollTop -= 100;
    await frame();
    ctx.scroll.scrollToBottom();
    await frame();
    await frame();

    expect(rowEdges(term).top).toBeCloseTo(BAND, 0);
  });

  it.each([
    [210, 221],
    [221, 210],
  ])("fits the rows again when the box goes from %ipx to %ipx", async (from, to) => {
    const { ctx, term } = await showing(from, lines(120));

    host?.style.setProperty("height", `${String(to)}px`);
    await shortSettled();
    ctx.scroll.scrollToBottom();
    await frame();
    await frame();

    expect(rowEdges(term).top).toBeCloseTo(BAND, 0);
    expect(ctx.render.computeSize().rows).toBe(Math.floor((to - 2 * BAND) / CELL));
  });
});

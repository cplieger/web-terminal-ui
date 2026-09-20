// kernel/attention.ts tests: the three out-of-page sinks, the change gate and
// the page-lifecycle rule. Every capability is injected (AttentionSinks), so the
// render paths are exercised without an installed app, a Badging API or icon
// assets; only the browserAttentionSinks block needs the DOM.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  browserAttentionSinks,
  createAttention,
  iconVariantHref,
  titleMarkFor,
  type AttentionSinks,
  type AttentionSurface,
} from "./attention.js";

/** A recording sink set with every optional sink present, so a test can assert
 *  both what was called and how often. */
function recorder(): {
  sinks: AttentionSinks;
  titles: string[];
  badges: number[];
  icons: (string | null)[];
} {
  const titles: string[] = [];
  const badges: number[] = [];
  const icons: (string | null)[] = [];
  return {
    titles,
    badges,
    icons,
    sinks: {
      setTitleMark: (text) => titles.push(text),
      setBadge: (count) => badges.push(count),
      setIcon: (variant) => icons.push(variant),
    },
  };
}

const live: AttentionSurface[] = [];
function attention(sinks: AttentionSinks): AttentionSurface {
  const surface = createAttention(sinks, window);
  live.push(surface);
  return surface;
}
afterEach(() => {
  // A surface left listening would answer the next test's pagehide too.
  for (const surface of live.splice(0)) {
    surface.dispose();
  }
});

describe("titleMarkFor formats the count for a truncating tab strip", () => {
  it("puts the digits first and disappears at zero", () => {
    expect(titleMarkFor(0)).toBe("");
    expect(titleMarkFor(1)).toBe("(1) ");
    expect(titleMarkFor(12)).toBe("(12) ");
  });
});

describe("createAttention renders a report onto the sinks", () => {
  it("sends the same number to the title and the badge, and the icon to its sink", () => {
    // Two surfaces disagreeing about how many things want you is worse than
    // either being absent, which is why both read one report.
    const rec = recorder();
    attention(rec.sinks).report({ count: 3, icon: "input" });
    expect(rec.titles).toEqual(["(3) "]);
    expect(rec.badges).toEqual([3]);
    expect(rec.icons).toEqual(["input"]);
  });

  it("touches nothing when the report has not changed", () => {
    // The title doubles as the browser-tab label and the bookmark name, and
    // re-assigning an icon href makes some browsers re-fetch it, so this runs on
    // every status sweep and must be idempotent.
    const rec = recorder();
    const surface = attention(rec.sinks);
    surface.report({ count: 2, icon: "done" });
    surface.report({ count: 2, icon: "done" });
    surface.report({ count: 2, icon: "done" });
    expect(rec.titles).toEqual(["(2) "]);
    expect(rec.badges).toEqual([2]);
    expect(rec.icons).toEqual(["done"]);
  });

  it("paints the first report even when it is empty, then stays quiet", () => {
    // The first render establishes the surfaces (a stale prefix from an earlier
    // runtime has to be cleared), and after that an unchanged empty report is not
    // re-applied.
    const rec = recorder();
    const surface = attention(rec.sinks);
    surface.report({ count: 0, icon: null });
    surface.report({ count: 0, icon: null });
    expect(rec.titles).toEqual([""]);
    expect(rec.badges).toEqual([0]);
    expect(rec.icons).toEqual([null]);
  });

  it("moves each surface only on the input it answers to", () => {
    // The count drives the title and the badge; the icon drives its own sink. A
    // change to one must not churn the other.
    const rec = recorder();
    const surface = attention(rec.sinks);
    surface.report({ count: 1, icon: "done" });
    surface.report({ count: 2, icon: "done" });
    surface.report({ count: 2, icon: "alert" });
    expect(rec.titles).toEqual(["(1) ", "(2) "]);
    expect(rec.badges).toEqual([1, 2]);
    expect(rec.icons).toEqual(["done", "alert"]);
  });

  it("clears every surface when the count returns to zero", () => {
    const rec = recorder();
    const surface = attention(rec.sinks);
    surface.report({ count: 1, icon: "input" });
    surface.report({ count: 0, icon: null });
    expect(rec.titles).toEqual(["(1) ", ""]);
    expect(rec.badges).toEqual([1, 0]);
    expect(rec.icons).toEqual(["input", null]);
  });

  it("works with every optional sink absent", () => {
    // A platform with no Badging API and an app that ships no icon variants must
    // still get the title, which is the floor no capability gates.
    const titles: string[] = [];
    const surface = attention({ setTitleMark: (text) => titles.push(text) });
    expect(() => surface.report({ count: 1, icon: "alert" })).not.toThrow();
    expect(titles).toEqual(["(1) "]);
  });
});

describe("the page lifecycle", () => {
  it("hands the surfaces back when the page goes away and repaints when it comes back", () => {
    // A browser remembers ONE icon per URL for the bookmark, the history row and
    // the new-tab tile, so a tab closed on a lit cue would leave a status variant
    // standing in for the app. A back-forward cache entry fires the same event and
    // that page comes BACK, so the last report is repainted rather than trusted to
    // a sink that is change-gated on the cleared value.
    const rec = recorder();
    attention(rec.sinks).report({ count: 1, icon: "input" });

    window.dispatchEvent(new Event("pagehide"));
    expect(rec.titles).toEqual(["(1) ", ""]);
    expect(rec.icons).toEqual(["input", null]);

    window.dispatchEvent(new Event("pageshow"));
    expect(rec.titles).toEqual(["(1) ", "", "(1) "]);
    expect(rec.icons).toEqual(["input", null, "input"]);
  });

  it("keeps the surfaces when the browser merely freezes the tab", () => {
    // A frozen tab is still in the strip rendering its icon and its title.
    const rec = recorder();
    attention(rec.sinks).report({ count: 1, icon: "input" });

    document.dispatchEvent(new Event("freeze"));
    expect(rec.titles).toEqual(["(1) "]);
    expect(rec.icons).toEqual(["input"]);
  });

  it("restores the surfaces on dispose and stops listening", () => {
    // The badge is OS-level and the icon links outlive the terminal, so nothing
    // else clears them; and a disposed surface answering a later pagehide would
    // write onto a page it no longer owns.
    const rec = recorder();
    const surface = attention(rec.sinks);
    surface.report({ count: 2, icon: "alert" });

    surface.dispose();
    expect(rec.titles).toEqual(["(2) ", ""]);
    expect(rec.badges).toEqual([2, 0]);
    expect(rec.icons).toEqual(["alert", null]);

    window.dispatchEvent(new Event("pageshow"));
    expect(rec.titles).toEqual(["(2) ", ""]);
  });

  it("leaves no listener behind when the second registration throws", () => {
    // Construction failed, so no surface reaches a caller who could dispose it;
    // the pagehide listener taken first must go with the throw.
    const add = window.addEventListener.bind(window);
    const addSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type, listener, options) => {
        if (type === "pageshow") {
          throw new Error("injected");
        }
        add(type, listener, options);
      });
    const rec = recorder();

    expect(() => createAttention(rec.sinks, window)).toThrow("injected");
    addSpy.mockRestore();

    window.dispatchEvent(new Event("pagehide"));
    expect(rec.titles).toEqual([]);
  });
});

describe("iconVariantHref follows the asset naming convention", () => {
  it("inserts the variant after the favicon token, keeping the extension", () => {
    expect(iconVariantHref("/favicon.svg", "input")).toBe("/favicon-input.svg");
    expect(iconVariantHref("/favicon-32x32.png", "done")).toBe("/favicon-done-32x32.png");
    expect(iconVariantHref("/favicon-16x16.png", "alert")).toBe("/favicon-alert-16x16.png");
    expect(iconVariantHref("favicon.svg", "input")).toBe("favicon-input.svg");
    expect(iconVariantHref("/static/icons/favicon.svg", "input")).toBe(
      "/static/icons/favicon-input.svg",
    );
  });

  it("declines a URL it cannot name a variant for", () => {
    // Returning null leaves that link alone. Pointing it at a guessed URL would
    // 404 and blank the tab icon, which is worse than showing no dot.
    expect(iconVariantHref("/logo.svg", "input")).toBeNull();
    expect(iconVariantHref("/icon-192x192.png", "input")).toBeNull();
    // "faviconx" is not the favicon token: the lookahead requires a separator.
    expect(iconVariantHref("/faviconx.svg", "input")).toBeNull();
  });
});

describe("browserAttentionSinks binds the sinks to the real browser", () => {
  // Every case here shadows the whole `navigator` object rather than adding and
  // deleting properties on the real one: Chromium SHIPS the Badging API, so
  // absence has to be constructed, and `delete navigator.setAppBadge` cannot undo
  // an `Object.assign(navigator, ...)` back to absence (setAppBadge is a
  // Navigator.prototype method, so the delete drops the own shadow and re-exposes
  // the platform's). A whole-object shadow has neither problem, and
  // `unstubGlobals: true` restores it.
  it("omits the badge sink when the Badging API is absent", () => {
    vi.stubGlobal("navigator", {});
    const sinks = browserAttentionSinks(vi.fn(), { icons: false }, document);
    expect(sinks.setBadge).toBeUndefined();
    expect(sinks.setIcon).toBeUndefined();
  });

  it("always passes a NUMBER, and clears through clearAppBadge", () => {
    // iOS renders nothing at all for the spec's bare flag form, so a count is the
    // only shape that works everywhere the API exists.
    const setAppBadge = vi.fn(() => Promise.resolve());
    const clearAppBadge = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { setAppBadge, clearAppBadge });
    const sinks = browserAttentionSinks(vi.fn(), { icons: false }, document);
    sinks.setBadge?.(4);
    sinks.setBadge?.(0);
    expect(setAppBadge).toHaveBeenCalledExactlyOnceWith(4);
    expect(clearAppBadge).toHaveBeenCalledOnce();
  });

  it("clears through setAppBadge(0) on a platform with no clearAppBadge", () => {
    // Chrome shipped setAppBadge before clearAppBadge; zero has to clear there
    // too, so the fallback arm is the only thing standing between that platform
    // and a badge that never goes away.
    const setAppBadge = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { setAppBadge });
    const sinks = browserAttentionSinks(vi.fn(), { icons: false }, document);
    sinks.setBadge?.(0);
    expect(setAppBadge).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("swallows a rejected badge, because an OS that will not paint one is normal", async () => {
    // The Badging API is present but non-functional on some desktops, where the
    // promise rejects. An unhandled rejection inside a status sweep would surface
    // as a page fault for a surface the user never asked about.
    const setAppBadge = vi.fn(() => Promise.reject(new Error("unsupported")));
    vi.stubGlobal("navigator", { setAppBadge });
    const sinks = browserAttentionSinks(vi.fn(), { icons: false }, document);
    expect(() => sinks.setBadge?.(1)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("swaps EVERY icon link and restores each one", () => {
    // Every link, because which one a browser picks differs between browsers:
    // Chrome prefers the SVG, so mutating a single element is unreliable.
    document.head.innerHTML = `
      <link rel="icon" type="image/svg+xml" href="/favicon.svg">
      <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    `;
    const sinks = browserAttentionSinks(vi.fn(), { icons: true }, document);
    const hrefs = (): string[] =>
      [...document.querySelectorAll("link")].map((l) => l.getAttribute("href") ?? "");

    sinks.setIcon?.("alert");
    expect(hrefs()).toEqual([
      "/favicon-alert.svg",
      "/favicon-alert-32x32.png",
      // The home-screen icon is NOT swapped: the OS caches it at install time, so
      // a swap cannot reach it, and rel~="icon" deliberately does not match it.
      "/apple-touch-icon.png",
    ]);

    sinks.setIcon?.(null);
    expect(hrefs()).toEqual(["/favicon.svg", "/favicon-32x32.png", "/apple-touch-icon.png"]);
  });

  it("omits the icon sink when the consumer has not opted in", () => {
    document.head.innerHTML = `<link rel="icon" href="/favicon.svg">`;
    expect(browserAttentionSinks(vi.fn(), { icons: false }, document).setIcon).toBeUndefined();
  });

  it("omits the icon sink when the page has no icon link to swap", () => {
    document.head.innerHTML = "";
    expect(browserAttentionSinks(vi.fn(), { icons: true }, document).setIcon).toBeUndefined();
  });
});

describe("the surfaces follow the document they were bound to", () => {
  // A same-origin iframe is a second document with a window of its own. A
  // terminal mounted there must light THAT document's icon and answer THAT
  // window's lifecycle, or two terminals in two documents would fight over one.
  function secondDocument(): { doc: Document; win: Window } {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) {
      throw new Error("no frame document");
    }
    return { doc, win };
  }
  afterEach(() => {
    for (const frame of document.querySelectorAll("iframe")) {
      frame.remove();
    }
    document.head.innerHTML = "";
  });

  it("swaps the icon links of the bound document and leaves the importing document's alone", () => {
    document.head.innerHTML = `<link rel="icon" href="/favicon.svg">`;
    const { doc } = secondDocument();
    doc.head.innerHTML = `<link rel="icon" href="/inner/favicon.svg">`;

    const sinks = browserAttentionSinks(vi.fn(), { icons: true }, doc);
    sinks.setIcon?.("alert");

    expect(doc.querySelector("link")?.getAttribute("href")).toBe("/inner/favicon-alert.svg");
    expect(document.querySelector("link")?.getAttribute("href")).toBe("/favicon.svg");
  });

  it("listens for pagehide on the bound window, not the importing one", () => {
    const { win } = secondDocument();
    const rec = recorder();
    const surface = createAttention(rec.sinks, win);
    live.push(surface);
    surface.report({ count: 3, icon: "done" });

    window.dispatchEvent(new Event("pagehide"));
    expect(rec.titles).toEqual(["(3) "]);

    win.dispatchEvent(new Event("pagehide"));
    expect(rec.titles).toEqual(["(3) ", ""]);
  });
});

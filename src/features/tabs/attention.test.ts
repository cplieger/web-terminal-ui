// @vitest-environment happy-dom
//
// tabs/attention.ts tests: the unseen-cue fold and the three out-of-page sinks.
// Every capability is injected (AttentionEnv), so the fold, the idempotence and
// the degradation paths are exercised without an installed app, a Badging API or
// icon assets; only the browserAttentionEnv block needs a DOM.

import { describe, it, expect, vi } from "vitest";
import {
  NO_ATTENTION,
  browserAttentionEnv,
  createAttention,
  iconVariantHref,
  summarize,
  titlePrefixFor,
} from "./attention.js";
import type { AttentionEnv } from "./attention.js";
import type { CueStatus } from "./model.js";

const seen = (entries: [string, CueStatus][] = []): Map<string, CueStatus> => new Map(entries);

/** A recording env with every optional sink present, so a test can assert both
 *  what was called and how often. */
function recorder(): {
  env: AttentionEnv;
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
    env: {
      titlePrefix: (text) => titles.push(text),
      setBadge: (count) => badges.push(count),
      setIcon: (variant) => icons.push(variant),
    },
  };
}

describe("summarize folds the tab list into one attention state", () => {
  it("reports nothing for an empty list and for a list with no cue", () => {
    expect(summarize([], seen())).toEqual(NO_ATTENTION);
    expect(
      summarize(
        [
          { id: "a", status: "working" },
          { id: "b", status: "idle" },
          { id: "c", status: "warning" },
          { id: "d", status: "exited" },
        ],
        seen(),
      ),
    ).toEqual(NO_ATTENTION);
  });

  it("counts every unacknowledged cue and keeps the most severe", () => {
    expect(
      summarize(
        [
          { id: "a", status: "done" },
          { id: "b", status: "input" },
          { id: "c", status: "working" },
        ],
        seen(),
      ),
    ).toEqual({ count: 2, worst: "input" });
  });

  it("orders severity crashed over failed over input over done", () => {
    // A single surface can show one state, so the order has to be total and
    // stated. Each pair is asserted BOTH ways round, because a comparison that
    // ignored its arguments' order would pass a one-directional test.
    const pairs: [CueStatus, CueStatus, CueStatus][] = [
      ["crashed", "failed", "crashed"],
      ["failed", "input", "failed"],
      ["input", "done", "input"],
      ["crashed", "done", "crashed"],
    ];
    for (const [first, second, worst] of pairs) {
      expect(
        summarize(
          [
            { id: "a", status: first },
            { id: "b", status: second },
          ],
          seen(),
        ).worst,
        `${first} vs ${second}`,
      ).toBe(worst);
      expect(
        summarize(
          [
            { id: "a", status: second },
            { id: "b", status: first },
          ],
          seen(),
        ).worst,
        `${second} vs ${first}`,
      ).toBe(worst);
    }
  });

  it("excludes a cue this viewer already acknowledged", () => {
    const list = [
      { id: "a", status: "input" },
      { id: "b", status: "crashed" },
    ];
    expect(summarize(list, seen([["a", "input"]]))).toEqual({ count: 1, worst: "crashed" });
    expect(
      summarize(
        list,
        seen([
          ["a", "input"],
          ["b", "crashed"],
        ]),
      ),
    ).toEqual(NO_ATTENTION);
  });

  it("counts a cue again once the session moves to a DIFFERENT cue", () => {
    // The acknowledgement is per (session, status), so a tab that was
    // acknowledged as done and then blocks on input is news again. This is the
    // half that a plain "have I seen this session" flag would get wrong.
    expect(summarize([{ id: "a", status: "input" }], seen([["a", "done"]]))).toEqual({
      count: 1,
      worst: "input",
    });
  });
});

describe("titlePrefixFor formats the count for a truncating tab strip", () => {
  it("puts the digits first and disappears at zero", () => {
    expect(titlePrefixFor(0)).toBe("");
    expect(titlePrefixFor(1)).toBe("(1) ");
    expect(titlePrefixFor(12)).toBe("(12) ");
  });
});

describe("createAttention renders a state onto the sinks", () => {
  it("sends the same number to the title and the badge", () => {
    // Two surfaces disagreeing about how many things want you is worse than
    // either being absent, which is why both read one fold.
    const rec = recorder();
    createAttention(rec.env).apply({ count: 3, worst: "input" });
    expect(rec.titles).toEqual(["(3) "]);
    expect(rec.badges).toEqual([3]);
    expect(rec.icons).toEqual(["input"]);
  });

  it("maps crashed and failed onto the one alert icon", () => {
    for (const status of ["crashed", "failed"] as const) {
      const rec = recorder();
      createAttention(rec.env).apply({ count: 1, worst: status });
      expect(rec.icons, status).toEqual(["alert"]);
    }
  });

  it("touches nothing when the state has not changed", () => {
    // The title doubles as the browser-tab label and the bookmark name, and
    // re-assigning an icon href makes some browsers re-fetch it, so this runs on
    // every status sweep and must be idempotent.
    const rec = recorder();
    const surfaces = createAttention(rec.env);
    surfaces.apply({ count: 2, worst: "done" });
    surfaces.apply({ count: 2, worst: "done" });
    surfaces.apply({ count: 2, worst: "done" });
    expect(rec.titles).toEqual(["(2) "]);
    expect(rec.badges).toEqual([2]);
    expect(rec.icons).toEqual(["done"]);
  });

  it("paints the first state even when it is empty, then stays quiet", () => {
    // The first apply establishes the surfaces (a stale prefix from an earlier
    // runtime has to be cleared), and after that an unchanged empty state is not
    // re-applied.
    const rec = recorder();
    const surfaces = createAttention(rec.env);
    surfaces.apply(NO_ATTENTION);
    surfaces.apply(NO_ATTENTION);
    expect(rec.titles).toEqual([""]);
    expect(rec.badges).toEqual([0]);
    expect(rec.icons).toEqual([null]);
  });

  it("moves each surface only on the input it answers to", () => {
    // The count drives the title and the badge; the worst status drives the icon.
    // A change to one must not churn the other.
    const rec = recorder();
    const surfaces = createAttention(rec.env);
    surfaces.apply({ count: 1, worst: "done" });
    surfaces.apply({ count: 2, worst: "done" }); // count only
    surfaces.apply({ count: 2, worst: "crashed" }); // worst only
    expect(rec.titles).toEqual(["(1) ", "(2) "]);
    expect(rec.badges).toEqual([1, 2]);
    expect(rec.icons).toEqual(["done", "alert"]);
  });

  it("clears every surface when the last cue is acknowledged", () => {
    const rec = recorder();
    const surfaces = createAttention(rec.env);
    surfaces.apply({ count: 1, worst: "input" });
    surfaces.apply(NO_ATTENTION);
    expect(rec.titles).toEqual(["(1) ", ""]);
    expect(rec.badges).toEqual([1, 0]);
    expect(rec.icons).toEqual(["input", null]);
  });

  it("works with every optional sink absent", () => {
    // A platform with no Badging API and an app that ships no icon variants must
    // still get the title, which is the floor no capability gates.
    const titles: string[] = [];
    const surfaces = createAttention({ titlePrefix: (text) => titles.push(text) });
    expect(() => surfaces.apply({ count: 1, worst: "crashed" })).not.toThrow();
    expect(titles).toEqual(["(1) "]);
  });
});

describe("iconVariantHref follows the asset generator's naming", () => {
  it("inserts the variant after the favicon token, keeping the extension", () => {
    // These expectations are the file names scripts/gen-attention-icons.py
    // actually writes. If either side changes, this is the test that fails.
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

describe("browserAttentionEnv binds the sinks to the real browser", () => {
  it("omits the badge sink when the Badging API is absent", () => {
    const env = browserAttentionEnv(vi.fn(), false);
    expect(env.setBadge).toBeUndefined();
    expect(env.setIcon).toBeUndefined();
  });

  it("always passes a NUMBER, and clears through clearAppBadge", async () => {
    // iOS renders nothing at all for the spec's bare flag form, so a count is the
    // only shape that works everywhere the API exists.
    const setAppBadge = vi.fn(() => Promise.resolve());
    const clearAppBadge = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    try {
      const env = browserAttentionEnv(vi.fn(), false);
      env.setBadge?.(4);
      env.setBadge?.(0);
      expect(setAppBadge).toHaveBeenCalledExactlyOnceWith(4);
      expect(clearAppBadge).toHaveBeenCalledOnce();
    } finally {
      delete (navigator as { setAppBadge?: unknown }).setAppBadge;
      delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
    }
  });

  it("swallows a rejected badge, because an OS that will not paint one is normal", async () => {
    // The Badging API is present but non-functional on some desktops, where the
    // promise rejects. An unhandled rejection inside a status sweep would surface
    // as a page fault for a surface the user never asked about.
    const setAppBadge = vi.fn(() => Promise.reject(new Error("unsupported")));
    Object.assign(navigator, { setAppBadge });
    try {
      const env = browserAttentionEnv(vi.fn(), false);
      expect(() => env.setBadge?.(1)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      delete (navigator as { setAppBadge?: unknown }).setAppBadge;
    }
  });

  it("swaps EVERY icon link and restores each one", () => {
    // Every link, because which one a browser picks differs between browsers:
    // Chrome prefers the SVG, so mutating a single element is unreliable.
    document.head.innerHTML = `
      <link rel="icon" type="image/svg+xml" href="/favicon.svg">
      <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    `;
    const env = browserAttentionEnv(vi.fn(), true);
    const hrefs = (): string[] =>
      [...document.querySelectorAll("link")].map((l) => l.getAttribute("href") ?? "");

    env.setIcon?.("alert");
    expect(hrefs()).toEqual([
      "/favicon-alert.svg",
      "/favicon-alert-32x32.png",
      // The home-screen icon is NOT swapped: the OS caches it at install time, so
      // a swap cannot reach it, and rel~="icon" deliberately does not match it.
      "/apple-touch-icon.png",
    ]);

    env.setIcon?.(null);
    expect(hrefs()).toEqual(["/favicon.svg", "/favicon-32x32.png", "/apple-touch-icon.png"]);
  });

  it("omits the icon sink when the consumer has not opted in", () => {
    document.head.innerHTML = `<link rel="icon" href="/favicon.svg">`;
    expect(browserAttentionEnv(vi.fn(), false).setIcon).toBeUndefined();
  });

  it("omits the icon sink when the page has no icon link to swap", () => {
    document.head.innerHTML = "";
    expect(browserAttentionEnv(vi.fn(), true).setIcon).toBeUndefined();
  });
});

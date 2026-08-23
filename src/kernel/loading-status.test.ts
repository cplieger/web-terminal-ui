// @vitest-environment happy-dom
//
// Contract tests for the loading overlay's progressive status text. The
// behaviour under test is a TIMELINE, so every case drives fake timers rather
// than waiting: what a user reads at 0s, 5s, 60s and beyond is the whole point
// of the module, and the delays are chosen deliberately (see loading-status.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  attachLoadingStatus,
  DEFAULT_LOADING_MESSAGES,
  type LoadingMessages,
  type LoadingStatus,
} from "./loading-status.js";

const INITIAL_DELAY_MS = 5000;
const WAITING_AFTER_MS = 60000;
const ROTATE_EVERY_MS = 20000;
const SWAP_FADE_MS = 400;

/** The overlay a full-page consumer supplies: a live region with a bar, exactly
 *  the canonical markup css/page.css styles. */
function overlayIn(): HTMLElement {
  const el = document.createElement("div");
  el.className = "wt-loading";
  el.setAttribute("role", "status");
  const bar = document.createElement("div");
  bar.className = "wt-loading-bar";
  bar.setAttribute("aria-hidden", "true");
  el.appendChild(bar);
  document.body.appendChild(el);
  return el;
}

const visibleText = (o: HTMLElement): string | null =>
  o.querySelector(".wt-loading-text")?.textContent ?? null;
const announcedText = (o: HTMLElement): string | null =>
  o.querySelector(".wt-loading-live")?.textContent ?? null;

/** Advance past a message swap, which fades out before it rewrites. */
function settleSwap(): void {
  vi.advanceTimersByTime(SWAP_FADE_MS);
}

describe("loading overlay status text", () => {
  let status: LoadingStatus | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    status = undefined;
  });
  afterEach(() => {
    status?.stop();
    vi.useRealTimers();
  });

  it("says nothing at all on a fast start", () => {
    const o = overlayIn();
    status = attachLoadingStatus(o);

    // The most common case, and the reason for the delay: a normal boot lowers
    // the overlay well inside a second. A message that flashed up and vanished
    // would be worse than silence, so nothing is written yet...
    vi.advanceTimersByTime(INITIAL_DELAY_MS - 1);
    expect(visibleText(o)).toBe("");
    expect(announcedText(o)).toBe("");

    // ...and the element is styled away while empty (css/page.css hides
    // .wt-loading-text:empty), so the screen is the bar alone.
    status.stop();
    expect(o.querySelector(".wt-loading-text")).toBeNull();
    expect(o.querySelector(".wt-loading-live")).toBeNull();
    // The consumer's own markup is returned untouched.
    expect(o.querySelector(".wt-loading-bar")).not.toBeNull();
    expect(o.className).toBe("wt-loading");
    expect(o.getAttribute("role")).toBe("status");
  });

  it("shows one calm line once the wait is real, and announces it once", () => {
    const o = overlayIn();
    status = attachLoadingStatus(o);

    vi.advanceTimersByTime(INITIAL_DELAY_MS);

    expect(visibleText(o)).toBe(DEFAULT_LOADING_MESSAGES.initial);
    // This transition IS meaningful, so it reaches assistive tech.
    expect(announcedText(o)).toBe(DEFAULT_LOADING_MESSAGES.initial);
  });

  it("rotates after a minute so a long wait never looks frozen", () => {
    const o = overlayIn();
    status = attachLoadingStatus(o);

    vi.advanceTimersByTime(WAITING_AFTER_MS);
    settleSwap();
    const first = visibleText(o);
    expect(DEFAULT_LOADING_MESSAGES.waiting).toContain(first);

    // A sentence frozen for nineteen more minutes reads as hung, which is the
    // whole reason the second tier rotates rather than standing still.
    const seen = new Set<string | null>([first]);
    for (let i = 0; i < DEFAULT_LOADING_MESSAGES.waiting.length - 1; i++) {
      vi.advanceTimersByTime(ROTATE_EVERY_MS);
      settleSwap();
      seen.add(visibleText(o));
    }
    expect(seen.size).toBe(DEFAULT_LOADING_MESSAGES.waiting.length);

    // ...and it wraps rather than running out and stalling on the last one.
    vi.advanceTimersByTime(ROTATE_EVERY_MS);
    settleSwap();
    expect(visibleText(o)).toBe(first);
  });

  it("does NOT announce the rotation", () => {
    const o = overlayIn();
    status = attachLoadingStatus(o);

    vi.advanceTimersByTime(INITIAL_DELAY_MS);
    const announcedOnce = announcedText(o);

    // The trap this pins: the overlay is a role="status" live region, so text
    // written into it is READ OUT. Four reassurance messages rotating every 20s
    // for a twenty-minute wait would interrupt a screen-reader user ~60 times to
    // say nothing new. The rotating line is aria-hidden and the announced line
    // holds still.
    vi.advanceTimersByTime(WAITING_AFTER_MS + ROTATE_EVERY_MS * 6);
    settleSwap();
    expect(announcedText(o)).toBe(announcedOnce);
    expect(visibleText(o)).not.toBe(announcedOnce);
    expect(o.querySelector(".wt-loading-text")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("lets a live reason supersede the scripted wording and stop the rotation", () => {
    const o = overlayIn();
    status = attachLoadingStatus(o);

    vi.advanceTimersByTime(WAITING_AFTER_MS);
    settleSwap();

    // The server's own words, arriving from the session owner's retry loop.
    status.reason("tools installing; waiting…");
    settleSwap();
    expect(visibleText(o)).toBe("tools installing; waiting…");
    expect(announcedText(o)).toBe("tools installing; waiting…");

    // Rotation must not resume and overwrite a real reason with reassurance:
    // alternating between "installing tools" and "almost there" is incoherent.
    vi.advanceTimersByTime(ROTATE_EVERY_MS * 3);
    settleSwap();
    expect(visibleText(o)).toBe("tools installing; waiting…");
  });

  it("keeps an EARLY reason when the rotation threshold arrives later", () => {
    const o = overlayIn();
    status = attachLoadingStatus(o);

    // This is the real production sequence, and the previous test is not it: the
    // server refuses session creation within a second or two, so the reason is
    // known LONG before the 60s rotation threshold. If the threshold ignored it,
    // a user reading "tools installing" at 0:05 would see it replaced by generic
    // reassurance at 1:00 -- losing the only useful information on the screen.
    vi.advanceTimersByTime(1500);
    status.reason("tools installing; waiting…");
    settleSwap();
    expect(visibleText(o)).toBe("tools installing; waiting…");

    vi.advanceTimersByTime(WAITING_AFTER_MS + ROTATE_EVERY_MS * 4);
    settleSwap();
    expect(visibleText(o)).toBe("tools installing; waiting…");
    // ...and the initial scripted line never appeared either.
    expect(announcedText(o)).toBe("tools installing; waiting…");
  });

  it("is idempotent per reason, so a retry loop may call it every tick", () => {
    const o = overlayIn();
    status = attachLoadingStatus(o);
    vi.advanceTimersByTime(INITIAL_DELAY_MS);

    status.reason("tools installing");
    settleSwap();
    const live = o.querySelector(".wt-loading-live") as HTMLElement;
    const spy = vi.spyOn(live, "textContent", "set");

    // The natural caller knows the reason on every retry tick. Re-writing the
    // announced line each time would re-read the same sentence to a screen
    // reader every few seconds, so an unchanged string must do nothing at all.
    for (let i = 0; i < 20; i++) {
      status.reason("tools installing");
    }
    expect(spy).not.toHaveBeenCalled();

    // A genuinely NEW reason still gets through.
    status.reason("starting session");
    settleSwap();
    expect(visibleText(o)).toBe("starting session");
    spy.mockRestore();
  });

  it("takes a consumer's wording where given and keeps the library's elsewhere", () => {
    const o = overlayIn();
    status = attachLoadingStatus(o, {
      ...DEFAULT_LOADING_MESSAGES,
      initial: "Waking the dev box…",
    });

    vi.advanceTimersByTime(INITIAL_DELAY_MS);
    expect(visibleText(o)).toBe("Waking the dev box…");

    vi.advanceTimersByTime(WAITING_AFTER_MS - INITIAL_DELAY_MS);
    settleSwap();
    expect(DEFAULT_LOADING_MESSAGES.waiting).toContain(visibleText(o));
  });

  it("goes quiet forever after stop(), so no timer outlives the overlay", () => {
    const o = overlayIn();
    status = attachLoadingStatus(o);

    // stop() runs from the same function that lowers the overlay. A pending
    // timer firing afterwards would write into a node that is fading out or
    // already removed.
    status.stop();
    vi.advanceTimersByTime(WAITING_AFTER_MS + ROTATE_EVERY_MS * 3);

    expect(o.querySelector(".wt-loading-text")).toBeNull();
    expect(o.querySelector(".wt-loading-live")).toBeNull();
    status.reason("too late");
    expect(o.querySelector(".wt-loading-text")).toBeNull();
    expect(() => {
      status?.stop();
    }).not.toThrow();
  });

  it("is inert when the consumer supplies no overlay", () => {
    // vibekit's shape: an embedded panel with no pre-JS overlay at all. The
    // kernel attaches unconditionally, so the no-overlay case must be a working
    // controller rather than something every caller has to null-check.
    status = attachLoadingStatus(undefined);
    expect(() => {
      status?.reason("anything");
      vi.advanceTimersByTime(WAITING_AFTER_MS * 2);
      status?.stop();
    }).not.toThrow();
    expect(document.querySelector(".wt-loading-text")).toBeNull();
  });

  it("keeps the announced line off-screen, so the wording is not on screen twice", () => {
    // The visible line and the announced line carry the same sentence at the
    // first threshold. The announced one is a live region's payload, not a
    // second paragraph, so it is clipped by the same technique the kernel
    // announcer uses; without that the overlay reads the message twice.
    const o = overlayIn();
    status = attachLoadingStatus(o);
    vi.advanceTimersByTime(INITIAL_DELAY_MS);

    const live = o.querySelector<HTMLElement>(".wt-loading-live");

    expect(live?.style.clipPath).toBe("inset(50%)");
    expect(live?.style.position).toBe("absolute");
    expect(live?.style.blockSize).toBe("1px");
  });

  it("fades the old wording out before writing the new one", () => {
    // A message that swaps instantly reads as a glitch, and the CSS transition
    // it fades with is on .wt-loading-text-out (css/page.css). The FIRST write
    // deliberately skips the fade: there is nothing to fade out and the line
    // would arrive half-transparent.
    const o = overlayIn();
    status = attachLoadingStatus(o);

    vi.advanceTimersByTime(INITIAL_DELAY_MS);
    // The first write is immediate and fully opaque.
    expect(visibleText(o)).toBe(DEFAULT_LOADING_MESSAGES.initial);
    expect(o.querySelector(".wt-loading-text")?.className).toBe("wt-loading-text");

    // The rotation's first message is a SWAP, so it fades first and the old
    // wording is still the one on screen while it does.
    vi.advanceTimersByTime(WAITING_AFTER_MS - INITIAL_DELAY_MS);
    expect(visibleText(o)).toBe(DEFAULT_LOADING_MESSAGES.initial);
    expect(o.querySelector(".wt-loading-text")?.classList.contains("wt-loading-text-out")).toBe(
      true,
    );

    settleSwap();
    expect(DEFAULT_LOADING_MESSAGES.waiting).toContain(visibleText(o));
    // ...and the fade class comes back off, or the line stays transparent.
    expect(o.querySelector(".wt-loading-text")?.classList.contains("wt-loading-text-out")).toBe(
      false,
    );
  });

  it("treats an empty reason as no reason at all", () => {
    // A retry loop that has lost the server's wording must not blank the line it
    // already put up: an empty string is the absence of a reason, not a new one.
    const o = overlayIn();
    status = attachLoadingStatus(o);
    vi.advanceTimersByTime(INITIAL_DELAY_MS);
    status.reason("tools installing");
    settleSwap();

    status.reason("");
    settleSwap();

    expect(visibleText(o)).toBe("tools installing");
    expect(announcedText(o)).toBe("tools installing");
  });

  it("clears the thresholds it armed but never reached", () => {
    // The common case: the overlay is lowered inside a second, so both scripted
    // timers are still pending when stop() runs. Either one firing afterwards
    // writes into a node that has already been removed.
    const o = overlayIn();
    status = attachLoadingStatus(o);
    expect(vi.getTimerCount()).toBe(2);

    status.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the rotation on stop, so nothing keeps ticking for twenty minutes", () => {
    const o = overlayIn();
    status = attachLoadingStatus(o);
    vi.advanceTimersByTime(WAITING_AFTER_MS);
    settleSwap();
    expect(vi.getTimerCount()).toBe(1); // the rotation interval, and only it

    status.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules nothing for a reason that arrives after stop()", () => {
    // The kernel lowers the overlay and the session owner's retry loop may be one
    // tick behind it. A reason that lands after stop() must not arm the fade
    // timer, which is the one thing here that outlives its own call.
    const o = overlayIn();
    status = attachLoadingStatus(o);
    vi.advanceTimersByTime(INITIAL_DELAY_MS);
    status.stop();

    status.reason("tools installing");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms no rotation for a consumer that supplies no waiting messages", () => {
    // A consumer may reword the initial line and decline the reassurance
    // rotation entirely. An interval over an empty list would tick forever
    // choosing between nothing.
    const o = overlayIn();
    status = attachLoadingStatus(o, { initial: "Waking the dev box…", waiting: [] });

    vi.advanceTimersByTime(WAITING_AFTER_MS);

    expect(visibleText(o)).toBe("Waking the dev box…");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("loading overlay status text: the wording the library ships", () => {
  // DEFAULT_LOADING_MESSAGES is built when the module is evaluated, so the copy
  // the suite above imported statically was already fixed before any test ran:
  // those tests exercise the code that READS the table. Re-importing per test is
  // what puts the shipped table itself under test.
  let attach: typeof attachLoadingStatus;
  let defaults: LoadingMessages;
  let status: LoadingStatus | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.replaceChildren();
    status = undefined;
    ({ attachLoadingStatus: attach, DEFAULT_LOADING_MESSAGES: defaults } =
      await import("./loading-status.js"));
  });
  afterEach(() => {
    status?.stop();
    vi.useRealTimers();
  });

  it("ships more than one waiting line, because one line cannot rotate", () => {
    // Step 3 of the design: a single sentence held for nineteen more minutes reads
    // exactly as hung as no sentence at all. The rotation is the point, and a
    // consumer that reworded nothing depends entirely on this table having
    // something in it.
    expect(defaults.waiting.length).toBeGreaterThan(1);
    for (const line of defaults.waiting) {
      expect(line).not.toBe("");
    }
  });

  it("moves off the initial line at the rotation threshold, and keeps moving", () => {
    // The observable consequence of the table for a consumer that overrides
    // nothing: at a minute the wording changes, and it changes again after that.
    // An empty table leaves the initial line frozen for the whole wait, silently.
    const o = overlayIn();
    status = attach(o);

    vi.advanceTimersByTime(INITIAL_DELAY_MS);
    settleSwap();
    expect(visibleText(o)).toBe(defaults.initial);

    vi.advanceTimersByTime(WAITING_AFTER_MS - INITIAL_DELAY_MS);
    settleSwap();
    const firstWaiting = visibleText(o);
    expect(firstWaiting).not.toBe(defaults.initial);
    expect(firstWaiting).not.toBe("");

    vi.advanceTimersByTime(ROTATE_EVERY_MS);
    settleSwap();
    expect(visibleText(o)).not.toBe(firstWaiting);
  });
});

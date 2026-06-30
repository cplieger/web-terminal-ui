// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as StatusModule from "./status.js";

let status: typeof StatusModule;
let banner: HTMLElement;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  status = await import("./status.js");
  banner = document.createElement("div");
  document.body.replaceChildren(banner);
  status.init({ banner });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("status: the loaded gate escalates to Offline only after N failed initial connects", () => {
  it("fewer than the initial-failure limit of closes before setLoaded() shows nothing", () => {
    // Three consecutive initial failures (below INITIAL_FAILURE_LIMIT = 4):
    // a merely-slow first connect must stay silent and defer to the
    // consumer's loading overlay — no banner, never escalated to Offline.
    status.closed();
    status.closed();
    status.closed();
    vi.advanceTimersByTime(1000);
    expect(banner.textContent).toBe("");
    expect(banner.classList.contains("visible")).toBe(false);
    expect(banner.dataset["state"]).not.toBe("offline");
  });

  it("reaching the initial-failure limit before setLoaded() surfaces Offline", () => {
    // Four consecutive initial failures (INITIAL_FAILURE_LIMIT): the
    // connection clearly isn't coming up, so the banner escalates to Offline
    // even though the first screen frame never rendered (setLoaded() is
    // never called) — no indefinite silent "Loading…".
    status.closed();
    status.closed();
    status.closed();
    status.closed();
    vi.advanceTimersByTime(600);
    expect(banner.textContent).toBe("Offline");
    expect(banner.dataset["state"]).toBe("offline");
    expect(banner.classList.contains("visible")).toBe(true);
  });
});

describe("status: connection state machine after load", () => {
  it("escalates to Offline after more than 3 consecutive failures", () => {
    status.setLoaded();
    status.closed();
    status.closed();
    status.closed();
    status.closed();
    vi.advanceTimersByTime(600);
    expect(banner.textContent).toBe("Offline");
    expect(banner.dataset["state"]).toBe("offline");
  });
  it("open() hides the banner and resets the failure count", () => {
    status.setLoaded();
    status.closed();
    status.closed();
    status.closed();
    status.closed();
    status.open();
    expect(banner.classList.contains("visible")).toBe(false);
    status.closed();
    vi.advanceTimersByTime(600);
    expect(banner.textContent).toBe("Reconnecting…");
  });
});

describe("status: toast lifecycle", () => {
  it("shows a transient message and auto-dismisses once the connection is open", () => {
    status.open();
    status.toast("Copied", 3000);
    expect(banner.textContent).toBe("Copied");
    expect(banner.classList.contains("visible")).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(banner.classList.contains("visible")).toBe(false);
  });
  it("restores the live status (not stale toast text) when a toast dismisses over a non-open state", () => {
    status.setLoaded();
    status.closed();
    status.closed();
    status.closed();
    status.closed();
    vi.advanceTimersByTime(600);
    expect(banner.textContent).toBe("Offline");
    // A toast raised while Offline temporarily overwrites the live banner…
    status.toast("Copied", 3000);
    expect(banner.textContent).toBe("Copied");
    // …but on dismiss the "Offline" status is restored, never stranded as "Copied".
    vi.advanceTimersByTime(3000);
    expect(banner.textContent).toBe("Offline");
    expect(banner.dataset["state"]).toBe("offline");
    expect(banner.classList.contains("visible")).toBe(true);
  });
});

describe("status: server-restart banner", () => {
  it("shows the restart warning and auto-clears to hidden after 4s", () => {
    status.setLoaded();
    status.restarted();
    expect(banner.textContent).toBe("Server restarted — recent input may have been lost");
    expect(banner.dataset["state"]).toBe("restarted");
    expect(banner.classList.contains("visible")).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(banner.classList.contains("visible")).toBe(false);
    expect(banner.textContent).toBe("");
  });

  it("does not auto-clear a reconnect state that arrived before the 4s timer", () => {
    status.setLoaded();
    status.restarted();
    status.closed();
    vi.advanceTimersByTime(600);
    expect(banner.textContent).toBe("Reconnecting…");
    vi.advanceTimersByTime(3400);
    expect(banner.textContent).toBe("Reconnecting…");
    expect(banner.classList.contains("visible")).toBe(true);
  });
});

describe("status: toast hover-pause", () => {
  it("pauses auto-dismiss while hovered, resumes on mouseleave", () => {
    status.setLoaded();
    status.open();
    status.toast("Copied", 3000);
    banner.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(3000);
    expect(banner.classList.contains("visible")).toBe(true);
    banner.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(3000);
    expect(banner.classList.contains("visible")).toBe(false);
  });
});

describe("status: toast escape-dismiss", () => {
  it("Escape clears a visible toast", () => {
    status.setLoaded();
    status.open();
    status.toast("Copied", 3000);
    expect(banner.classList.contains("visible")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(banner.classList.contains("visible")).toBe(false);
  });
});

describe("status: reconnecting() suppression and rendering", () => {
  it("stays suppressed when called before setLoaded()", () => {
    status.reconnecting();
    vi.advanceTimersByTime(600);
    expect(banner.classList.contains("visible")).toBe(false);
    expect(banner.textContent).toBe("");
  });

  it("shows Reconnecting… after the grace delay once loaded", () => {
    status.setLoaded();
    status.reconnecting();
    // Suppressed during the grace window…
    expect(banner.classList.contains("visible")).toBe(false);
    vi.advanceTimersByTime(600);
    // …then the banner appears in the reconnecting state.
    expect(banner.textContent).toBe("Reconnecting…");
    expect(banner.dataset["state"]).toBe("reconnecting");
    expect(banner.classList.contains("visible")).toBe(true);
  });
});

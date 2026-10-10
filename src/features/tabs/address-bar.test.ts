import { afterEach, describe, expect, it, vi } from "vitest";

import { createAddressBar, type AddressBar, type RouteOrigin } from "./address-bar.js";

const basePath = location.pathname + location.search;
let bar: AddressBar | null = null;

afterEach(() => {
  bar?.dispose();
  bar = null;
  history.replaceState(null, "", basePath);
});

const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

// A popstate after history.back() is a task the browser queues; wait for it.
const navigated = (): Promise<void> =>
  new Promise((resolve) => {
    window.addEventListener(
      "popstate",
      () => {
        setTimeout(resolve, 0);
      },
      { once: true },
    );
  });

function mount(shown: { value: string | null }, applied: [string, RouteOrigin][] = []): AddressBar {
  bar = createAddressBar(window, {
    read: () => shown.value,
    apply: (fragment, origin) => {
      applied.push([fragment, origin]);
    },
  });
  return bar;
}

describe("createAddressBar", () => {
  it("canonicalises on start without adding an entry, and marks it", () => {
    const shown = { value: "#aaaa" };
    const before = history.length;
    mount(shown).start(true);
    expect(location.hash).toBe("#aaaa");
    expect(history.length).toBe(before);
    expect(history.state).toEqual({ wtTabs: 1 });
  });

  it("writes nothing before start", async () => {
    const shown = { value: "#aaaa" };
    mount(shown).schedule("push");
    await nextTask();
    expect(location.hash).toBe("");
  });

  it("leaves the fragment alone on start(false)", () => {
    history.replaceState(null, "", "#stale");
    mount({ value: "#aaaa" }).start(false);
    expect(location.hash).toBe("#stale");
  });

  it("pushes one entry per task and lets push win over replace", async () => {
    const shown = { value: "#aaaa" };
    const b = mount(shown);
    b.start(true);
    const before = history.length;
    shown.value = "#bbbb";
    b.schedule("replace");
    b.schedule("push");
    b.schedule("replace");
    await nextTask();
    expect(location.hash).toBe("#bbbb");
    expect(history.length).toBe(before + 1);
  });

  it("replaces without adding an entry", async () => {
    const shown = { value: "#aaaa" };
    const b = mount(shown);
    b.start(true);
    const before = history.length;
    shown.value = "#bbbb";
    b.schedule("replace");
    await nextTask();
    expect(location.hash).toBe("#bbbb");
    expect(history.length).toBe(before);
  });

  it("writes nothing when the fragment is already current", async () => {
    const shown = { value: "#aaaa" };
    const b = mount(shown);
    b.start(true);
    const before = history.length;
    b.schedule("push");
    await nextTask();
    expect(history.length).toBe(before);
  });

  it("writes nothing while there is nothing to name", async () => {
    const shown: { value: string | null } = { value: "#aaaa" };
    const b = mount(shown);
    b.start(true);
    shown.value = null;
    b.schedule("push");
    await nextTask();
    expect(location.hash).toBe("#aaaa");
  });

  it("replaces rather than pushes a fragment-free address", async () => {
    const shown = { value: "#aaaa" };
    const b = mount(shown);
    b.start(true);
    const before = history.length;
    shown.value = "";
    b.schedule("push");
    await nextTask();
    expect(location.hash).toBe("");
    expect(history.length).toBe(before);
  });

  it("keeps the path and the query", async () => {
    history.replaceState(null, "", `${basePath}${basePath.includes("?") ? "&" : "?"}k=v`);
    const keep = location.pathname + location.search;
    const shown = { value: "#aaaa" };
    const b = mount(shown);
    b.start(true);
    shown.value = "#bbbb";
    b.schedule("push");
    await nextTask();
    expect(location.pathname + location.search).toBe(keep);
    expect(location.hash).toBe("#bbbb");
  });

  it("applies a typed fragment once, as a deep link, then canonicalises", async () => {
    const shown = { value: "#aaaa" };
    const applied: [string, RouteOrigin][] = [];
    mount(shown, applied).start(true);
    shown.value = "#cccc";
    location.hash = "#bbbb";
    await nextTask();
    await nextTask();
    expect(applied).toEqual([["#bbbb", "deeplink"]]);
    expect(location.hash).toBe("#cccc");
    expect(history.state).toEqual({ wtTabs: 1 });
  });

  it("applies a back onto its own entry as history", async () => {
    const shown = { value: "#aaaa" };
    const applied: [string, RouteOrigin][] = [];
    const b = mount(shown, applied);
    b.start(true);
    shown.value = "#bbbb";
    b.schedule("push");
    await nextTask();
    const done = navigated();
    history.back();
    await done;
    expect(applied).toEqual([["#aaaa", "history"]]);
  });

  it("drops a schedule made while applying", async () => {
    const shown = { value: "#aaaa" };
    const b: AddressBar = createAddressBar(window, {
      read: () => shown.value,
      apply: () => {
        shown.value = "#dddd";
        b.schedule("push");
      },
    });
    bar = b;
    b.start(true);
    const push = vi.spyOn(history, "pushState");
    location.hash = "#bbbb";
    await nextTask();
    await nextTask();
    expect(push).not.toHaveBeenCalled();
    expect(location.hash).toBe("#dddd");
  });

  it("does nothing after dispose", async () => {
    const shown = { value: "#aaaa" };
    const apply = vi.fn();
    const b = createAddressBar(window, { read: () => shown.value, apply });
    b.start(true);
    b.dispose();
    location.hash = "#bbbb";
    await nextTask();
    b.schedule("push");
    await nextTask();
    expect(apply).not.toHaveBeenCalled();
    expect(location.hash).toBe("#bbbb");
  });

  it("reads a reload as a restore and a fresh load as a deep link", () => {
    const b = mount({ value: null });
    const spy = vi.spyOn(performance, "getEntriesByType");
    spy.mockReturnValue([{ type: "reload" } as unknown as PerformanceEntry]);
    expect(b.bootOrigin()).toBe("restore");
    spy.mockReturnValue([{ type: "back_forward" } as unknown as PerformanceEntry]);
    expect(b.bootOrigin()).toBe("restore");
    spy.mockReturnValue([{ type: "navigate" } as unknown as PerformanceEntry]);
    expect(b.bootOrigin()).toBe("deeplink");
    spy.mockReturnValue([]);
    expect(b.bootOrigin()).toBe("deeplink");
  });
});

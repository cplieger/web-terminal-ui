// The app badge through the real tabs feature, over a navigator whose one OS
// badge can lose writes without telling the page (WebKit resolves setAppBadge
// before webpushd applies it). Each case loses the writes of one read, then
// drives one event that must re-assert the count folded from the unread state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import { tabs } from "./index.js";
import { mountTerminal } from "../../test-helpers/mount.js";
import type { TerminalFeature, TerminalHandle } from "../../kernel/types.js";
import type { ActivityMonitorApi } from "../activity-monitor.js";

interface OsBadge {
  badge: number;
  /** While set, every write is lost, as with no webpushd connection. */
  dropping: boolean;
  writes: number;
}

function stubBadge(os: OsBadge): void {
  const write = (count: number): Promise<void> => {
    os.writes++;
    if (!os.dropping) {
      os.badge = count;
    }
    return Promise.resolve();
  };
  // Own properties shadow Chromium's Navigator.prototype methods; deleting them
  // in afterEach restores the platform's.
  Object.defineProperty(navigator, "setAppBadge", { value: write, configurable: true });
  Object.defineProperty(navigator, "clearAppBadge", {
    value: () => write(0),
    configurable: true,
  });
}

interface Banner {
  tag: string | undefined;
  closed: boolean;
  onclick: ((event: Event) => void) | null;
}
const banners: Banner[] = [];
class FakeNotification {
  static permission = "granted";
  static requestPermission(): Promise<string> {
    return Promise.resolve("granted");
  }
  tag: string | undefined;
  closed = false;
  onclick: ((event: Event) => void) | null = null;
  constructor(_title: string, options?: { tag?: string }) {
    this.tag = options?.tag;
    banners.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

function fakeMonitor(): {
  feature: TerminalFeature<ActivityMonitorApi>;
  emit: (s: SessionStatus) => void;
  open: () => void;
} {
  const subs = new Set<(s: SessionStatus) => void>();
  const opens = new Set<() => void>();
  const feature: TerminalFeature<ActivityMonitorApi> = {
    name: "activityMonitor",
    scope: "shell",
    setup() {
      return {
        api: {
          onStatus(cb) {
            subs.add(cb);
            return () => subs.delete(cb);
          },
          current: () => undefined,
          onStreamOpen(cb) {
            opens.add(cb);
            return () => opens.delete(cb);
          },
        },
        teardown: () => undefined,
      };
    },
  };
  return {
    feature,
    emit: (s) => {
      for (const cb of [...subs]) {
        cb(s);
      }
    },
    open: () => {
      for (const cb of [...opens]) {
        cb();
      }
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let list: unknown[];
const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (String(url).endsWith("/layout")) {
    return Promise.resolve(
      method === "PUT"
        ? jsonResponse(null, 204)
        : jsonResponse(
            { left: null, right: null, handle: 0.5, selected: "left", open: false },
            200,
          ),
    );
  }
  if (method !== "GET") {
    return Promise.resolve(jsonResponse(null, 204));
  }
  return Promise.resolve(jsonResponse(list, 200));
});

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

let term: TerminalHandle | undefined;
let os: OsBadge;

beforeEach(() => {
  fetchMock.mockClear();
  list = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
  ];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Notification", FakeNotification);
  banners.length = 0;
  document.body.replaceChildren();
  localStorage.clear();
  setVisibility("visible");
  os = { badge: 0, dropping: false, writes: 0 };
  stubBadge(os);
});

afterEach(() => {
  term?.destroy();
  term = undefined;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "setAppBadge");
  Reflect.deleteProperty(navigator, "clearAppBadge");
  setVisibility("visible");
  document.title = "";
});

/** A re-assert lands on the next task. */
function nextTask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function until(pred: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mount(): Promise<{ root: HTMLElement; monitor: ReturnType<typeof fakeMonitor> }> {
  const monitor = fakeMonitor();
  const root = document.createElement("div");
  document.body.appendChild(root);
  term = await mountTerminal(root, {
    features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
  });
  await until(() => root.querySelectorAll(".wt-tab").length === list.length);
  return { root, monitor };
}

function chip(root: HTMLElement, index: number): HTMLElement {
  const el = root.querySelectorAll<HTMLElement>(".wt-tab")[index];
  if (!el) {
    throw new Error(`no tab ${String(index)}`);
  }
  return el;
}

/** s2 finishes in the background, raising the badge to 1; then every write made
 *  while reading it is lost, so the OS keeps 1 while the page folds 0. */
async function stuckAfterRead(): Promise<{
  root: HTMLElement;
  monitor: ReturnType<typeof fakeMonitor>;
}> {
  const mounted = await mount();
  mounted.monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2", statusSeq: 1 });
  expect(os.badge, "a background cue raises the badge").toBe(1);
  os.dropping = true;
  chip(mounted.root, 1).click();
  os.dropping = false;
  expect(document.title.startsWith("("), "the page folds no unread cue").toBe(false);
  expect(os.badge, "the dropped clear left the OS badge up").toBe(1);
  return mounted;
}

describe("the app badge follows the real unread state", () => {
  it("sets on a new background cue and clears on reading it", async () => {
    const { root, monitor } = await mount();
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2", statusSeq: 1 });
    expect(os.badge).toBe(1);

    chip(root, 1).click();
    expect(os.badge).toBe(0);
  });

  it("re-asserts on the next read even when the count does not change", async () => {
    const { root } = await stuckAfterRead();
    chip(root, 0).click();
    await nextTask();
    expect(os.badge).toBe(0);
  });

  it("re-asserts when a fresh cue arrives on the session the user is watching", async () => {
    const { monitor } = await stuckAfterRead();
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2", statusSeq: 2 });
    await nextTask();
    expect(os.badge).toBe(0);
  });

  it("re-asserts when the page becomes visible", async () => {
    await stuckAfterRead();
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await nextTask();
    expect(os.badge).toBe(0);
  });

  it("writes once when coming back into view acknowledges the shown tab", async () => {
    const { monitor } = await mount();
    setVisibility("hidden");
    monitor.emit({ id: "s1", status: "done", title: "one", createdAt: "1", statusSeq: 1 });
    expect(os.badge).toBe(1);
    const writes = os.writes;

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await nextTask();
    expect(os.badge).toBe(0);
    expect(os.writes - writes).toBe(1);
  });

  it("re-asserts when the window gains focus", async () => {
    await stuckAfterRead();
    window.dispatchEvent(new Event("focus"));
    await nextTask();
    expect(os.badge).toBe(0);
  });

  it("re-asserts on pageshow", async () => {
    await stuckAfterRead();
    window.dispatchEvent(new Event("pageshow"));
    await nextTask();
    expect(os.badge).toBe(0);
  });

  it("re-asserts once a reopened status stream's listing is folded in", async () => {
    const { monitor } = await stuckAfterRead();
    monitor.open();
    monitor.open();
    await until(() => os.badge === 0);
    expect(os.badge).toBe(0);
  });

  it("re-asserts when the tray opens and acknowledges every tab", async () => {
    const { root } = await stuckAfterRead();
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    await nextTask();
    expect(os.badge).toBe(0);
  });

  it("clears when another window or device reads the cue", async () => {
    // This page is hidden and still counts s2; the reader saw it elsewhere, and
    // the server's broadcast carries the raised seen floor here.
    const { monitor } = await mount();
    setVisibility("hidden");
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2", statusSeq: 1 });
    expect(os.badge).toBe(1);

    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      statusSeq: 1,
      seenSeq: 1,
    });
    expect(os.badge).toBe(0);
    expect(document.title.startsWith("(")).toBe(false);
  });

  it("re-asserts when a read elsewhere leaves the count alone", async () => {
    const { monitor } = await stuckAfterRead();
    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      statusSeq: 1,
      seenSeq: 1,
    });
    await nextTask();
    expect(os.badge).toBe(0);
  });

  it("puts out the switch button's dot for a session read elsewhere", async () => {
    const { root, monitor } = await mount();
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2", statusSeq: 1 });
    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    expect(dot?.dataset["status"], "a background cue lights the dot").toBe("done");

    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      statusSeq: 1,
      seenSeq: 1,
    });
    expect(dot?.dataset["status"]).toBeUndefined();
  });

  it("clears when the user clicks the session's notification", async () => {
    const { monitor } = await mount();
    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      statusSeq: 1,
      notification: "Response complete",
      notificationSeq: 1,
    });
    expect(os.badge).toBe(1);
    expect(banners).toHaveLength(1);

    banners[0]?.onclick?.(new Event("click"));
    expect(os.badge).toBe(0);
  });
});

describe("no seen state is kept in the browser", () => {
  it("writes nothing to localStorage when a cue is read", async () => {
    const { root, monitor } = await mount();
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2", statusSeq: 1 });
    chip(root, 1).click();
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
    expect(keys.filter((k) => k.startsWith("wt-cue-seen"))).toEqual([]);
  });

  it("ignores a stored acknowledgement another build left behind", async () => {
    const { monitor } = await mount();
    setVisibility("hidden");
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2", statusSeq: 1 });
    localStorage.setItem("wt-cue-seen/s2", "done");
    window.dispatchEvent(new StorageEvent("storage", { key: "wt-cue-seen/s2" }));
    await nextTask();
    expect(os.badge).toBe(1);
    expect(document.title.startsWith("(1) ")).toBe(true);
  });
});

describe("a delivered notification closes once its session is read", () => {
  it("closes the banner when the user switches to that tab", async () => {
    const { root, monitor } = await mount();
    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      statusSeq: 1,
      notification: "Response complete",
      notificationSeq: 1,
    });
    expect(banners.map((b) => [b.tag, b.closed])).toEqual([["s2", false]]);

    chip(root, 1).click();
    expect(banners[0]?.closed).toBe(true);
  });

  it("closes the banner of the shown tab when the page comes back into view", async () => {
    const { monitor } = await mount();
    setVisibility("hidden");
    monitor.emit({
      id: "s1",
      status: "done",
      title: "one",
      createdAt: "1",
      statusSeq: 1,
      notification: "Response complete",
      notificationSeq: 1,
    });
    expect(banners.map((b) => [b.tag, b.closed])).toEqual([["s1", false]]);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(banners[0]?.closed).toBe(true);
  });

  it("closes the banner when another window or device reads that session", async () => {
    const { monitor } = await mount();
    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      statusSeq: 1,
      notification: "Response complete",
      notificationSeq: 1,
    });
    expect(banners.map((b) => [b.tag, b.closed])).toEqual([["s2", false]]);

    monitor.emit({
      id: "s1",
      status: "done",
      title: "one",
      createdAt: "1",
      statusSeq: 1,
      seenSeq: 1,
    });
    expect(banners[0]?.closed, "a read of another session leaves it up").toBe(false);

    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      statusSeq: 1,
      seenSeq: 1,
    });
    expect(banners[0]?.closed).toBe(true);
  });

  it("leaves a background tab's banner up while the user reads another tab", async () => {
    const { root, monitor } = await mount();
    chip(root, 1).click();
    monitor.emit({
      id: "s1",
      status: "done",
      title: "one",
      createdAt: "1",
      statusSeq: 1,
      notification: "Response complete",
      notificationSeq: 1,
    });
    chip(root, 1).click();
    expect(banners[0]?.closed).toBe(false);
  });
});

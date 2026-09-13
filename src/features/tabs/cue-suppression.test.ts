// A settled turn raises no cue while a background task it launched is still
// running (foldedCueStatus), and this file drives that through the REAL cue path
// rather than against the fold in isolation: a mobile switch dot, a document-title
// count and the wt-cue-seen acknowledgement map are three surfaces reached by two
// different code paths (applyStatus's latest-wins raise, and paintAttention's fold
// over the whole strip), so a suppression that landed on one and not the other
// would read as fixed while still nagging.
//
// The cases here are the ways the suppression and the mark's own withdrawal can
// fight, because the mark withdraws when a task reaches a terminal state and the
// suppression therefore LIFTS for a turn that settled minutes earlier: the cue has
// to fire then, a dismissal made before the task started has to survive it, and
// the tab in front of the user still has to raise nothing — not even after the
// reader has moved on to another tab, which is what makes the acknowledgement read
// the tab's RAW status while only the raise reads the folded one.
//
// A separate file from index.test.ts purely so concurrent workers do not edit one
// file; the setup idioms (real kernel, stubbed fetch, dynamic import per test, a
// fake activityMonitor for the status stream) are the ones that file established.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import type * as KernelModule from "../../kernel/kernel.js";
import type * as TabsModule from "./index.js";
import type { TerminalFeature } from "../../kernel/types.js";
import type { ActivityMonitorApi } from "../activity-monitor.js";
// A plain string constant, so reading it through a separate module instance than
// the (dynamically re-imported) feature under test is safe.
import { CUE_SEEN_KEY } from "./model.js";

/** A status event carrying the secondary-activity fields. They are declared here
 *  rather than on the engine's SessionStatus for the reason model.ts's
 *  StatusRecord declares them: the published engine's wire type does not have
 *  them yet, and a newer server sends them. */
type ActivityStatus = SessionStatus & {
  readonly activity?: string;
  readonly activityCount?: number;
};

/** A fake activityMonitor: pushes status events into tabs without the real SSE.
 *  tabs reads it via ctx.use, so the same feature value goes into the features
 *  array (before tabs) and into tabs({ activityMonitor }). Its presence also
 *  switches the poll timer off, so the only list round-trips are the test's. */
function fakeMonitor(): {
  feature: TerminalFeature<ActivityMonitorApi>;
  emit: (s: ActivityStatus) => void;
} {
  const subs = new Set<(s: SessionStatus) => void>();
  const feature: TerminalFeature<ActivityMonitorApi> = {
    name: "activityMonitor",
    setup() {
      return {
        api: {
          onStatus(cb) {
            subs.add(cb);
            return () => subs.delete(cb);
          },
          current: () => undefined,
          onStreamOpen() {
            return () => undefined;
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
  };
}

let createTerminal: (typeof KernelModule)["createTerminal"];
let tabs: (typeof TabsModule)["tabs"];
let term: ReturnType<(typeof KernelModule)["createTerminal"]> | undefined;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let list: unknown[];

const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "POST") {
    return Promise.resolve(
      jsonResponse({ id: "s-new", title: "fresh", createdAt: "9", status: "idle" }, 201),
    );
  }
  if (method === "DELETE" || method === "PUT") {
    return Promise.resolve(jsonResponse(null, 204));
  }
  void url;
  return Promise.resolve(jsonResponse(list, 200));
});

// Page visibility is a FIXTURE, not ambient state: the active-tab acknowledgement
// defers while hidden, so a test that inherited whatever the previous one left
// would pass or fail by ordering.
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockClear();
  list = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
  ];
  vi.stubGlobal("fetch", fetchMock);
  document.body.replaceChildren();
  document.title = "Host page";
  localStorage.clear();
  setVisibility("visible");
  ({ createTerminal } = await import("../../kernel/kernel.js"));
  ({ tabs } = await import("./index.js"));
});

afterEach(() => {
  term?.destroy();
  term = undefined;
  vi.unstubAllGlobals();
  setVisibility("visible");
  document.title = "";
});

async function until(pred: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Mount with a status stream wired, the way every cue test needs it. */
async function mount(): Promise<{
  root: HTMLElement;
  monitor: ReturnType<typeof fakeMonitor>;
}> {
  const monitor = fakeMonitor();
  const root = document.createElement("div");
  document.body.appendChild(root);
  term = createTerminal(root, {
    features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
  });
  await until(() => root.querySelectorAll(".wt-tab").length === list.length);
  return { root, monitor };
}

/** The aggregate cue as the mobile switch button shows it, "" for no cue. */
function switchDot(root: HTMLElement): string {
  return root.querySelector<HTMLElement>(".wt-switcher-switch-dot")?.dataset["status"] ?? "";
}

/** This viewer's acknowledgements as they reached storage. */
function acknowledged(): Record<string, string> {
  return JSON.parse(localStorage.getItem(CUE_SEEN_KEY) ?? "{}") as Record<string, string>;
}

describe("a background task suppresses its session's settled cue", () => {
  it("raises nothing while the task runs, then fires when the task ends", async () => {
    // The conflict this feature creates: the mark withdraws at the task's terminal
    // state, so the suppression LIFTS for a turn that settled long before. The
    // withdrawal event changes the activity and NOTHING else — same session, same
    // `done` — so the cue only fires if that one field reaches the fold.
    const { root, monitor } = await mount();
    expect(document.title).toBe("Host page");

    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      activity: "working",
      activityCount: 1,
    });
    expect(switchDot(root), "the switch dot stays dark while the task runs").toBe("");
    expect(document.title, "the title count stays clear while the task runs").toBe("Host page");

    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      activity: "",
      activityCount: 0,
    });
    expect(switchDot(root), "the switch dot lights when the task ends").toBe("done");
    expect(document.title, "the title counts the cue when the task ends").toBe("(1) Host page");
  });

  it("keeps the mark out of the tab's own dot, which reports the turn", async () => {
    // Only the cue's VIEW of the status is blanked. The strip renders the turn's
    // real state throughout, or the reader loses the one signal that says the turn
    // itself finished.
    const { root, monitor } = await mount();
    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      activity: "working",
      activityCount: 2,
    });

    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[1];
    expect(chip?.querySelector<HTMLElement>(".wt-status-dot")?.dataset["status"]).toBe("done");
    expect(chip?.querySelector<HTMLElement>(".wt-activity-mark")?.dataset["activity"]).toBe(
      "working",
    );
  });

  it("does not re-raise a cue this viewer had already dismissed", async () => {
    // The decision the "" sentinel exists for. A suppressed cue is NO INFORMATION,
    // so it must leave the acknowledgement map alone; blanking with a real non-cue
    // state instead (`idle`) would FORGET the dismissal while the task ran and
    // re-raise the cue from scratch the moment it ended — for a session the viewer
    // had already visited.
    const { root, monitor } = await mount();
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2" });
    expect(switchDot(root)).toBe("done");

    // Opening the tray lists every tab's own dot, which is what acknowledges them.
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    expect(switchDot(root)).toBe("");
    expect(acknowledged()).toEqual({ s2: "done" });

    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      activity: "working",
      activityCount: 1,
    });
    expect(acknowledged(), "the dismissal survives the task starting").toEqual({ s2: "done" });

    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      activity: "",
      activityCount: 0,
    });
    expect(switchDot(root), "the task ending re-raises nothing").toBe("");
    expect(document.title, "and adds nothing to the count").toBe("Host page");
    expect(acknowledged()).toEqual({ s2: "done" });
  });

  it("raises nothing for the tab the user is looking at when its task ends", async () => {
    // A latch on the active tab is acknowledged as it happens, so the withdrawal
    // must not become a notification about a turn the user watched finish. The
    // acknowledgement is the proof the active-tab rule ran rather than the
    // suppression merely still holding.
    const { root, monitor } = await mount();
    expect(root.querySelectorAll<HTMLElement>(".wt-tab")[0]?.className).toContain("wt-tab-active");

    monitor.emit({
      id: "s1",
      status: "done",
      title: "one",
      createdAt: "1",
      activity: "working",
      activityCount: 1,
    });
    expect(switchDot(root)).toBe("");

    monitor.emit({
      id: "s1",
      status: "done",
      title: "one",
      createdAt: "1",
      activity: "",
      activityCount: 0,
    });
    expect(switchDot(root), "the active tab raises no cue when its task ends").toBe("");
    expect(document.title).toBe("Host page");
    expect(acknowledged()).toEqual({ s1: "done" });
  });

  it("acknowledges the watched turn while it is suppressed, so leaving cannot arm it", async () => {
    // The suppression must not defer the active tab's acknowledgement, because
    // the reader can leave before it lifts: switching away acknowledges the tab
    // ARRIVED on, and the tray is the only other route. So a turn settling under
    // a live task on the tab in front of the reader, then a switch, then the task
    // ending, raised a cue for a turn that reader watched finish.
    const { root, monitor } = await mount();

    monitor.emit({
      id: "s1",
      status: "done",
      title: "one",
      createdAt: "1",
      activity: "working",
      activityCount: 1,
    });
    expect(acknowledged(), "the watched turn is acknowledged as it settles").toEqual({
      s1: "done",
    });

    root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.click();
    expect(root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.className).toContain("wt-tab-active");

    monitor.emit({
      id: "s1",
      status: "done",
      title: "one",
      createdAt: "1",
      activity: "",
      activityCount: 0,
    });
    expect(acknowledged(), "the acknowledgement outlives the switch").toEqual({ s1: "done" });
    expect(switchDot(root), "so the switch dot stays dark once the task ends").toBe("");
    expect(document.title, "and the title counts nothing").toBe("Host page");
  });

  it("still forgets the watched tab's acknowledgement when its turn moves on", async () => {
    // The acknowledgement is on the (session, latch) PAIR and the watched tab is
    // no exception: a new working phase drops it, whether or not a task is
    // running, or the NEXT turn to finish in the background reads as the one the
    // reader already saw.
    const { root, monitor } = await mount();
    monitor.emit({
      id: "s1",
      status: "done",
      title: "one",
      createdAt: "1",
      activity: "working",
      activityCount: 1,
    });
    monitor.emit({
      id: "s1",
      status: "working",
      title: "one",
      createdAt: "1",
      activity: "working",
      activityCount: 1,
    });
    expect(acknowledged(), "a new working phase drops the acknowledgement").toEqual({});

    root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.click();
    monitor.emit({
      id: "s1",
      status: "done",
      title: "one",
      createdAt: "1",
      activity: "",
      activityCount: 0,
    });
    expect(switchDot(root), "so the next turn to finish in the background raises").toBe("done");
    expect(document.title, "and the title counts it").toBe("(1) Host page");
  });

  it("keeps a cue the viewer is being pointed at, and one for a dead process", async () => {
    // The scoping, through the real path: a session's own unanswered question is
    // what the cue exists to point at, and a crashed process has to be reported —
    // a task belonging to it is dead too.
    const { root, monitor } = await mount();

    monitor.emit({
      id: "s2",
      status: "input",
      title: "two",
      createdAt: "2",
      activity: "working",
      activityCount: 1,
    });
    expect(switchDot(root)).toBe("input");
    expect(document.title).toBe("(1) Host page");

    monitor.emit({
      id: "s2",
      status: "crashed",
      title: "two",
      createdAt: "2",
      activity: "working",
      activityCount: 1,
    });
    expect(switchDot(root)).toBe("crashed");
    expect(document.title).toBe("(1) Host page");
  });
});

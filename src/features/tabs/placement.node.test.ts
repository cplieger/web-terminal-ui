import { describe, expect, it } from "vitest";

import {
  ackFailed,
  ackSettled,
  createBegan,
  layoutRecord,
  layoutStale,
  ownCreated,
  paneFailed,
  paneStartFailed,
  removed,
  resyncBegan,
  ownReleased,
  resyncSettled,
  route,
  select,
  shellChanged,
  show,
  snap,
  splitFit,
  splitIntent,
  splitRatio,
  switcherToggled,
  pageVisibility,
  windowFocused,
  type SplitOpening,
} from "./placement.js";
import type { TabAlias } from "./route.js";
import {
  bootPage,
  endedRec,
  rec,
  singleRecord,
  splitRecord,
  type Page,
} from "./test-helpers/placement-world.js";

const alias = (s: string): TabAlias => s as TabAlias;

/** Split X|Y, X selected, committed. */
function splitXY(...more: string[]): Page {
  return bootPage(["X", "Y", ...more], splitRecord("X", "Y"));
}

function own(p: Page, id: string, opening: SplitOpening | null = null): Page {
  return p.apply((m) => ownCreated(m, rec(id), opening, false));
}

describe("an arrival beside a failed start", () => {
  it.each([
    ["the arrival listed before the live tab's row", ["Z", "X", "Y"]],
    ["the arrival listed between the live row and the ended one", ["X", "Z", "Y"]],
    ["the arrival listed after the ended one", ["X", "Y", "Z"]],
  ])("places a snapshot arrival beside the ended pane, %s", (_name, order) => {
    const p = splitXY();
    const open = p.open();
    const rows = {
      X: rec("X", { status: "working", statusSeq: 1 }),
      Y: endedRec("Y"),
      Z: rec("Z"),
    };
    for (const id of order) {
      p.stream(rows[id as keyof typeof rows]);
    }
    p.opened(open, [rows.X, rows.Y, rows.Z]).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
  });

  it("gives a snapshot arrival only its chip beside two ended panes", () => {
    const p = splitXY();
    const open = p.open();
    p.stream(endedRec("X")).stream(endedRec("Y")).stream(rec("Z"));
    p.opened(open, [endedRec("X"), endedRec("Y"), rec("Z")]).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    expect(p.lay.strip).toContain("Z");
  });

  it("moves an arrival off a pane whose session the page then learns failed to start", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    expect(p.panes).toEqual(["X", "Z"]);
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
  });

  it("keeps a failed start's pane from an arrival when its 4001 lands before the listed end", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => paneStartFailed(m, "Y", "spawn failed")).commit();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
    expect(p.m.sessions.get("Y")?.startFailure).toBe("spawn failed");
  });

  it("gives a failed start's pane back after the user clicked into the arrival that covered it", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => select(m, "right")).commit();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
  });

  it.each([
    ["learned last", false],
    ["learned first", true],
  ])(
    "puts an arrival back only where it would have gone when a start failure is %s among later arrivals",
    (_name, first) => {
      const p = splitXY();
      if (first) {
        p.stream(endedRec("Y")).commit();
      }
      p.stream(rec("Z")).commit();
      p.stream(rec("Z2")).commit();
      if (!first) {
        p.stream(endedRec("Y")).commit();
      }
      expect(p.panes).toEqual(["Z2", "Y"]);
      expect(p.lay.split.selected).toBe("left");
    },
  );

  it("keeps the user's new terminal when a start failure is learned after it", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply(createBegan);
    own(p, "N").commit();
    expect(p.panes).toEqual(["N", "Z"]);
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["N", "Y"]);
  });

  it("shows a failed start again after the split collapsed onto the arrival that covered it", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.gone("X").commit();
    expect(p.panes).toEqual(["Z", null]);
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Y", null]);
    expect(p.lay.split.open).toBe(false);
  });

  it("opens the split a host opened, with the right pane empty and the selection kept", () => {
    const p = bootPage(["X", "Y"], singleRecord("X"));
    p.apply((m) => shellChanged(m, { kind: "splitOpened", selected: "left" })).commit();
    expect(p.lay.split).toEqual({ open: true, selected: "left" });
    expect(p.panes).toEqual(["X", null]);
    p.stream(rec("Z")).commit();
    expect(p.panes).toEqual(["X", "Z"]);
  });

  it("keeps the session the narrowed window kept when a start failure is learned after", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => shellChanged(m, { kind: "splitClosed", keptId: "Z" })).commit();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z", null]);
  });

  it.each([
    ["learned last", false],
    ["learned first", true],
  ])(
    "keeps the selection where it was when a start failure %s sends an arrival to its chip",
    (_name, first) => {
      const p = splitXY();
      p.stream(endedRec("X")).commit();
      if (first) {
        p.stream(endedRec("Y")).commit();
      }
      p.stream(rec("Z")).commit();
      if (!first) {
        p.stream(endedRec("Y")).commit();
      }
      expect(p.panes).toEqual(["X", "Y"]);
      expect(p.lay.split.selected).toBe("left");
    },
  );

  it("returns the selection to the pane selected before the arrival when the user clicked into it and its covered start failed", () => {
    const p = splitXY();
    p.stream(endedRec("X")).commit();
    p.stream(rec("Z")).commit();
    expect(p.panes).toEqual(["X", "Z"]);
    p.apply((m) => select(m, "right")).commit();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    expect(p.lay.split.selected).toBe("left");
  });

  it("gives a failed start's pane back during a stream reopen", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    const open = p.open();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
    p.opened(open, [rec("X"), endedRec("Y"), rec("Z")]).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
  });

  it("still gives its pane to a session made elsewhere when the pane's process exited", () => {
    const p = splitXY();
    p.stream(rec("Y", { status: "exited", statusSeq: 1 })).commit();
    p.stream(rec("Z")).commit();
    expect(p.panes).toEqual(["X", "Z"]);
  });

  it("gives a session made elsewhere only its chip over a single view on an ended tab", () => {
    const p = bootPage(["X", "Y"], singleRecord("X"));
    p.stream(endedRec("X")).commit();
    p.stream(rec("Z")).commit();
    expect(p.panes).toEqual(["X", null]);
  });

  it("announces a session made elsewhere that takes the selected pane", () => {
    const p = splitXY();
    p.apply((m) => select(m, "right")).commit();
    const fx = p.stream(rec("Z")).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
    expect(fx.focus?.form).toBe("announce");
  });
});

describe("holds", () => {
  it("keeps a session made elsewhere in its pane through a stream reopen and a +", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    const open = p.open();
    p.commit();
    expect(p.panes).toEqual(["X", "Z"]);
    p.opened(open, [rec("X"), rec("Y"), rec("Z")]).commit();
    expect(p.panes).toEqual(["X", "Z"]);
    p.apply(createBegan);
    own(p, "N").commit();
    expect(p.panes).toEqual(["N", "Z"]);
  });

  it.each([
    ["one frame", false],
    ["two frames", true],
  ])("gives the same panes when a removal and an arrival land in %s", (_name, between) => {
    const p = splitXY();
    p.stream(rec("Z"));
    if (between) {
      p.commit();
    }
    p.gone("Y").commit();
    expect(p.panes).toEqual(["X", "Z"]);
  });

  it("shows this page's new session once when the stream delivers it before its POST answers", () => {
    const p = splitXY();
    p.apply(createBegan);
    p.stream(rec("N")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    own(p, "N").commit();
    expect(p.panes).toEqual(["X", "N"]);
  });

  it("shows the user's new terminal after the sessions made elsewhere while its POST was out", () => {
    const p = splitXY();
    p.apply(createBegan);
    p.stream(rec("Z1")).stream(rec("Z2")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    own(p, "N").commit();
    expect(p.panes).toContain("N");
    expect(p.lay.panes[p.lay.split.selected]).toBe("N");
  });

  it.each([
    ["oldest first", ["Z1", "Z2"]],
    ["newest first", ["Z2", "Z1"]],
  ])("places a burst's arrivals the same when its rows come %s", (_name, order) => {
    const p = splitXY();
    const open = p.open();
    for (const id of order) {
      p.stream(rec(id));
    }
    p.opened(open, [rec("X"), rec("Y"), rec("Z1"), rec("Z2")]).commit();
    expect(p.panes).toEqual(["Z2", "Z1"]);
    expect(p.lay.split.selected).toBe("left");
  });

  it("places arrivals again after a stream open whose list fails", () => {
    const p = splitXY();
    p.opened(p.open(), null);
    p.stream(rec("Z")).commit();
    expect(p.panes).toEqual(["X", "Z"]);
  });

  it("does not place a session made elsewhere again when the user opened it during the hold", () => {
    const p = splitXY();
    const open = p.open();
    p.stream(rec("Z"));
    p.apply((m) => show(m, "Z")).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
    p.opened(open, [rec("X"), rec("Y"), rec("Z")]).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
  });
});

describe("restarts and resyncs", () => {
  it("resyncs when a poll misses every known tab and places the new set by the record", () => {
    const p = splitXY();
    p.list([rec("R1"), rec("R2")]).commit();
    expect(p.requested).toBe(1);
    expect(p.panes).toEqual(["X", "Y"]);
    p.resync([rec("R1"), rec("R2")], splitRecord("R1", "R2")).commit();
    expect(p.panes).toEqual(["R1", "R2"]);
  });

  it("places a restarted server's sessions by the address when the stream reopen's snapshot names only them", () => {
    const p = splitXY();
    const open = p.open();
    p.stream(rec("R1")).stream(rec("R2"));
    p.opened(open, [rec("R1"), rec("R2")]).commit();
    expect(p.requested).toBe(1);
    p.stream(rec("R3")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    p.resync([rec("R1"), rec("R2"), rec("R3")], splitRecord("R1", "R2")).commit();
    expect(p.panes).toEqual(["R1", "R2"]);
    expect(p.lay.strip).toContain("R3");
  });

  it("starts one resync when a restart list lands while another reconcile is queued", () => {
    const p = splitXY();
    p.list([rec("R1"), rec("R2")]).commit();
    p.stream(rec("R3")).commit();
    p.list([rec("R1"), rec("R2"), rec("R3")]).commit();
    expect(p.requested).toBe(1);
  });

  it("writes the settled set once after a 409 whose re-list shows a restart", () => {
    const p = splitXY();
    p.apply((m) => splitRatio(m, 0.3, false)).commit();
    const before = p.writes.length;
    p.list([rec("R1"), rec("R2")]);
    p.apply(layoutStale).commit();
    p.resync([rec("R1"), rec("R2")], splitRecord("R1", "R2", "left", 0.3)).commit();
    p.commit();
    expect(p.writes.slice(before).map((w) => w.record)).toEqual([
      splitRecord("R1", "R2", "left", 0.3),
    ]);
  });

  it("does not place a session held across a resync", () => {
    const p = splitXY();
    p.list([rec("R1")]).commit();
    const ids = p.resyncs.shift() ?? [];
    p.apply((m) => resyncBegan(m, ids, false, 0));
    p.stream(rec("Z1"));
    p.apply((m) =>
      resyncSettled(m, {
        sessions: [rec("R1"), rec("Z1")],
        record: null,
        route: null,
        toastStale: false,
        now: 0,
      }),
    ).commit();
    expect(p.panes).toEqual(["R1", null]);
    expect(p.lay.strip).toContain("Z1");
  });

  it("shows the settled session and the new one when a + answers in the same frame as a resync's settle", () => {
    const p = splitXY();
    p.list([rec("R1")]).commit();
    const ids = p.resyncs.shift() ?? [];
    p.apply(createBegan);
    p.apply((m) => resyncBegan(m, ids, false, 0));
    own(p, "N", { by: "button" });
    p.apply((m) =>
      resyncSettled(m, {
        sessions: [rec("R1")],
        record: null,
        route: null,
        toastStale: false,
        now: 0,
      }),
    ).commit();
    expect(p.panes).toEqual(["R1", null]);
    p.apply(ownReleased).commit();
    expect(p.panes).toEqual(["R1", "N"]);
  });

  it("shows the new terminal when a resync's settle fails while its create was answered", () => {
    const p = splitXY();
    p.list([rec("R1")]).commit();
    const ids = p.resyncs.shift() ?? [];
    p.apply(createBegan);
    p.apply((m) => resyncBegan(m, ids, false, 0));
    own(p, "N");
    p.apply((m) =>
      resyncSettled(m, { sessions: [], record: null, route: null, toastStale: false, now: 0 }),
    )
      .apply(ownReleased)
      .commit();
    expect(p.panes).toContain("N");
  });

  it("drops only the tab a list no longer names when it still names the ended one", () => {
    const p = splitXY("W");
    p.stream(endedRec("Y")).commit();
    p.list([endedRec("Y"), rec("W")]).commit();
    expect(p.panes).toEqual(["Y", null]);
    expect(p.m.sessions.get("Y")?.startFailure).toBe("spawn failed");
    expect(p.requested).toBe(0);
  });

  it("keeps a split with two ended panes as it is", () => {
    const p = splitXY("W");
    p.stream(endedRec("X")).stream(endedRec("Y")).commit();
    p.list([endedRec("X"), endedRec("Y"), rec("W")]).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    expect(p.requested).toBe(0);
  });
});

describe("the switch dot and the reads", () => {
  it("keeps a hidden tab's cue when a stream arrival with a cue is placed", () => {
    const p = splitXY("W");
    p.stream(rec("W", { status: "done", statusSeq: 1 })).commit();
    expect(p.lay.indicators.switchDot).toBe("done");
    p.stream(rec("Z", { status: "input", statusSeq: 1 })).commit();
    expect(p.panes).toEqual(["X", "Z"]);
    expect(p.lay.indicators.switchDot).toBe("done");
  });

  it("keeps a hidden tab's cue when a poll lists an arrival with a cue after it", () => {
    const p = splitXY("W");
    p.list([
      rec("X"),
      rec("Y"),
      rec("W", { status: "done", statusSeq: 1 }),
      rec("Z", { status: "input", statusSeq: 1 }),
    ]).commit();
    expect(p.lay.indicators.switchDot).toBe("done");
  });

  it("keeps a hidden tab's cue when a stream reopen's list names an arrival with a cue", () => {
    const p = splitXY("W");
    const open = p.open();
    p.opened(open, [
      rec("X"),
      rec("Y"),
      rec("W", { status: "done", statusSeq: 1 }),
      rec("Z", { status: "input", statusSeq: 1 }),
    ]).commit();
    expect(p.panes).toEqual(["X", "Z"]);
    expect(p.lay.indicators.switchDot).toBe("done");
  });

  it("shows the next unread tab's cue after the most urgent is read", () => {
    const p = splitXY("W", "V");
    p.stream(rec("W", { status: "done", statusSeq: 1 }));
    p.stream(rec("V", { status: "crashed", statusSeq: 1 })).commit();
    expect(p.lay.indicators.switchDot).toBe("crashed");
    expect(p.lay.indicators.attention.count).toBe(2);
    p.apply((m) => show(m, "V")).commit();
    expect(p.lay.indicators.switchDot).toBe("done");
    expect(p.acks).toContainEqual({ id: "V", seq: 1 });
  });

  it("acknowledges a cue that arrives while the tab list is open", () => {
    const p = splitXY("W");
    p.apply((m) => switcherToggled(m, true)).commit();
    p.stream(rec("W", { status: "done", statusSeq: 2 })).commit();
    expect(p.acks).toContainEqual({ id: "W", seq: 2 });
    expect(p.lay.indicators.switchDot).toBe("");
  });

  it("counts a cue that latches on a shown tab while the page is hidden", () => {
    const p = splitXY();
    p.apply((m) => pageVisibility(m, false)).commit();
    p.stream(rec("X", { status: "done", statusSeq: 1 })).commit();
    expect(p.lay.indicators.attention.count).toBe(1);
    expect(p.acks).toEqual([]);
    p.apply((m) => pageVisibility(m, true)).commit();
    expect(p.acks).toEqual([{ id: "X", seq: 1 }]);
    expect(p.lay.indicators.attention.count).toBe(0);
  });

  it.each([
    ["a frame between them", true],
    ["one frame", false],
  ])("acknowledges a cue on a shown tab whose page then hides, with %s", (_name, between) => {
    const p = splitXY("W");
    p.stream(rec("Y", { status: "input", statusSeq: 1 }));
    if (between) {
      p.commit();
    }
    p.apply((m) => pageVisibility(m, false)).commit();
    expect(p.acks).toEqual([{ id: "Y", seq: 1 }]);
    expect(p.lay.indicators.switchDot).toBe("");
    expect(p.lay.indicators.attention.count).toBe(0);
  });

  it("shows a clicked tab while a seen PUT is out", () => {
    const p = splitXY("W");
    p.stream(rec("W", { status: "done", statusSeq: 1 })).commit();
    p.apply((m) => show(m, "W")).commit();
    p.apply((m) => ackSettled(m, "W", 1)).commit();
    expect(p.panes).toEqual(["W", "Y"]);
  });

  it("re-sends a failed seen PUT when the window regains focus", () => {
    const p = splitXY();
    p.stream(rec("X", { status: "done", statusSeq: 1 })).commit();
    p.apply((m) => ackFailed(m, "X", 1, false)).commit();
    expect(p.acks).toEqual([{ id: "X", seq: 1 }]);
    p.apply(windowFocused).commit();
    expect(p.acks).toEqual([
      { id: "X", seq: 1 },
      { id: "X", seq: 1 },
    ]);
  });
});

describe("closes", () => {
  it.each([
    ["the split C|D", splitRecord("C", "D"), ["C", "D"], "B"],
    ["the single view C", singleRecord("C"), ["C", "D"], "B"],
    ["the single view B, closing right of A", singleRecord("B"), ["B", "C", "D"], "A"],
  ])(
    "a multi-close that takes %s shows the neighbour the close leaves",
    (_name, record, ids, shown) => {
      const p = bootPage(["A", "B", "C", "D"], record);
      p.apply((m) => removed(m, ids, { by: "user" }, 0)).commit();
      expect(p.panes).toEqual([shown, null]);
    },
  );

  it("close others keeps the tab it was opened on", () => {
    const p = bootPage(["X", "Y", "W", "V"], splitRecord("X", "Y"));
    p.apply((m) => removed(m, ["X", "Y", "W"], { by: "user" }, 0)).commit();
    expect(p.panes).toEqual(["V", null]);
  });

  it("focuses the input once after a close while typing", () => {
    const p = splitXY();
    const fx = p.apply((m) => removed(m, ["X"], { by: "user", typing: true }, 0)).commit();
    expect(fx.focus?.typing).toBe(true);
    const later = p.stream(rec("Y", { status: "working", statusSeq: 1 })).commit();
    expect(later.focus).toBeNull();
  });

  it("keeps the surviving tab selected when the split collapses onto the right pane", () => {
    const p = bootPage(["X", "Y"], splitRecord("X", "Y", "right"));
    p.gone("X").commit();
    expect(p.panes).toEqual(["Y", null]);
    expect(p.lay.split).toEqual({ open: false, selected: "left" });
  });

  it("ignores a click on a tab closed elsewhere before the frame paints it away", () => {
    const p = splitXY("Z");
    p.gone("Z");
    p.apply((m) => show(m, "Z")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    expect(p.lay.strip).not.toContain("Z");
  });
});

describe("the user's placements", () => {
  it("opens the split beside the tab shown before when two arrivals moved the selection", () => {
    for (const between of [false, true]) {
      const p = splitXY();
      p.stream(rec("Z1"));
      if (between) {
        p.commit();
      }
      p.stream(rec("Z2")).commit();
      p.apply((m) => splitIntent(m, false)).commit();
      p.apply((m) => splitIntent(m, true)).commit();
      expect(p.panes).toEqual(["Z2", "Z1"]);
    }
  });

  it("opens the split for a new terminal when the split button has no partner", () => {
    const p = bootPage(["X"], singleRecord("X"));
    p.apply(createBegan);
    own(p, "N", { by: "button" }).commit();
    expect(p.panes).toEqual(["X", "N"]);
  });

  it("closes the split onto the unselected pane's tab with a route naming only it", () => {
    const p = splitXY();
    p.apply((m) => route(m, { kind: "single", tab: alias("Y") }, false)).commit();
    expect(p.panes).toEqual(["Y", null]);
    expect(p.lay.split.open).toBe(false);
  });

  it("moves an ended tab with the address, where it shows its end again", () => {
    const p = splitXY();
    p.stream(endedRec("X")).stream(endedRec("Y")).commit();
    p.apply((m) =>
      route(m, { kind: "split", left: alias("Y"), right: alias("X") }, false),
    ).commit();
    expect(p.panes).toEqual(["Y", "X"]);
  });

  it("snaps an ended tab out of the single view beside its partner, creating nothing", () => {
    const p = bootPage(["X", "Y"], singleRecord("X"));
    p.stream(endedRec("X")).commit();
    p.apply((m) => snap(m, "X", "right", false)).commit();
    expect(p.panes).toEqual(["Y", "X"]);
    expect(p.m.holds.create).toBe(false);
  });

  it("refuses a snap the window cannot fit", () => {
    const p = bootPage(["X", "Y"], singleRecord("X"), { canOpen: false });
    p.apply((m) => snap(m, "X", "right", false)).commit();
    expect(p.panes).toEqual(["X", null]);
    expect(p.lay.split.open).toBe(false);
  });

  it("returns the keyboard to the input when the shown tab's chip is clicked", () => {
    const p = splitXY();
    const fx = p.apply((m) => show(m, "X")).commit();
    expect(fx.focus?.form).toBe("focus");
  });

  it("keeps the selection the kernel moved to an empty pane while no pane shows a tab", () => {
    const p = splitXY();
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "left", id: "X" }));
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "right", id: "Y" })).commit();
    p.apply((m) => select(m, "right")).commit();
    expect(p.panes).toEqual([null, null]);
    expect(p.lay.split.selected).toBe("right");
  });

  it("remembers the pane the user clicked into", () => {
    const p = splitXY();
    const fx = p.apply((m) => select(m, "right")).commit();
    expect(fx.persist).toBe(true);
    expect(p.writes.at(-1)?.record.selected).toBe("right");
  });

  it("writes the divider's share after a drag and keeps it in a pane change's write", () => {
    const p = splitXY("W");
    p.apply((m) => splitRatio(m, 0.3, true)).commit();
    expect(p.writes.at(-1)?.record.handle).toBe(0.3);
    p.apply((m) => show(m, "W")).commit();
    expect(p.writes.at(-1)?.record).toEqual(layoutRecord(p.lay, 0.3));
    expect(p.writes.at(-1)?.record.handle).toBe(0.3);
  });
});

describe("kernel pane changes", () => {
  it("keeps the split open with the failure shown when the second pane fails while it holds the only shown tab", () => {
    const p = bootPage(["X", "T"], splitRecord(null, "T", "right"));
    p.apply((m) => paneFailed(m, "right"));
    p.apply((m) => shellChanged(m, { kind: "rehome", side: "left", id: "T" })).commit();
    expect(p.panes).toEqual(["T", null]);
    expect(p.lay.split.open).toBe(true);
    expect(p.lay.failed.right).toBe(true);
  });

  it("opens the split beside its partner after the second pane failed and the split was closed", () => {
    const p = splitXY();
    p.apply((m) => paneFailed(m, "right"));
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "right", id: "Y" })).commit();
    p.apply((m) => splitIntent(m, false)).commit();
    expect(p.lay.failed.right).toBeUndefined();
    p.apply((m) => splitIntent(m, true)).commit();
    expect(p.panes).toEqual(["X", "Y"]);
  });

  it("refuses a route split the window cannot fit", () => {
    const p = bootPage(["X", "Y"], singleRecord("X"), { canOpen: false });
    const fx = p
      .apply((m) => splitFit(m, false))
      .apply((m) => route(m, { kind: "split", left: alias("X"), right: alias("Y") }, false))
      .commit();
    expect(p.lay.split.open).toBe(false);
    expect(fx.toasts).toContain("narrow");
  });
});

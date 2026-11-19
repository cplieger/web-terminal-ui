import { describe, expect, it } from "vitest";

import { CLOSE_TOMBSTONE_MS } from "./model.js";
import {
  EMPTY_LAYOUT,
  ackFailed,
  ackSettled,
  createBegan,
  createFailed,
  createModel,
  dragChanged,
  layoutRecord,
  layoutStale,
  mergeRecord,
  ownCreated,
  paneFailed,
  paneStartFailed,
  removed,
  reorder,
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
  splitPartner,
  splitRatio,
  switcherToggled,
  pageVisibility,
  windowFocused,
  type SplitOpening,
  type TabsModel,
} from "./placement.js";
import type { StatusRecord } from "./model.js";
import type { TabAlias, TabRoute } from "./route.js";
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

describe("close tombstones keep a closed tab from coming back", () => {
  const closedAt = 20_000;
  const listed = { listedAt: 0 };
  const closedA = () =>
    removed(
      mergeRecord(createModel(), rec("A"), { stream: true }, 0),
      ["A"],
      { by: "user" },
      closedAt,
    );

  it("keeps a stale listing from re-adding a session closed inside the window", () => {
    const m = mergeRecord(closedA(), rec("A"), listed, closedAt + CLOSE_TOMBSTONE_MS - 1);
    expect(m.sessions.has("A")).toBe(false);
  });

  it("adds the session back once the window has passed", () => {
    const m = mergeRecord(closedA(), rec("A"), listed, closedAt + CLOSE_TOMBSTONE_MS);
    expect(m.sessions.has("A")).toBe(true);
  });

  it("adds a listed session the page never closed", () => {
    const m = mergeRecord(closedA(), rec("B"), listed, closedAt + 1);
    expect(m.sessions.has("B")).toBe(true);
  });

  it("keeps a live tombstone through a later close's sweep of elapsed ones", () => {
    const later = closedAt + 1000;
    let m = mergeRecord(closedA(), rec("B"), { stream: true }, later);
    m = removed(m, ["B"], { by: "user" }, later);
    expect(mergeRecord(m, rec("A"), listed, later).sessions.has("A")).toBe(false);
  });
});

describe("an arrival beside a failed start", () => {
  it("keeps both panes when a covered session the user showed on the other pane fails to start", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    expect(p.panes).toEqual(["X", "Z"]);
    p.apply((m) => select(m, "left"))
      .apply((m) => show(m, "Y"))
      .commit();
    expect(p.panes).toEqual(["Y", "Z"]);
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Y", "Z"]);
  });
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

  it.each([
    ["in a later frame", true],
    ["in the same frame", false],
  ])(
    "opens the split with the new terminal beside the shown tab when its POST answers after a restart list %s",
    (_name, frame) => {
      const p = bootPage(["X", "Y"], singleRecord("Y"));
      const open = p.open();
      p.stream(rec("R1"))
        .apply((m) => show(m, "R1"))
        .commit();
      p.apply(createBegan).opened(open, [rec("R1")]);
      if (frame) {
        p.commit();
      }
      own(p, "N1", { by: "button" }).commit();
      p.resync([rec("R1"), rec("N1")], null).commit();
      expect([p.panes, p.lay.split]).toEqual([["R1", "N1"], { open: true, selected: "right" }]);
    },
  );

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

  it("raises the switch dot for an arrival with an unread cue that is only a chip", () => {
    const p = bootPage(["X", "Y"], singleRecord("X"));
    p.stream(rec("Z", { status: "done", statusSeq: 1 })).commit();
    expect(p.panes).toEqual(["X", null]);
    expect(p.lay.indicators.switchDot).toBe("done");
    expect(p.lay.indicators.attention.count).toBe(1);
  });

  it.each([
    ["a poll lists", false],
    ["a stream reopen releases", true],
  ])(
    "keeps the cue of an arrival a later arrival covers when %s them together",
    (_name, reopen) => {
      const p = splitXY();
      const rows = [
        rec("X"),
        rec("Y"),
        rec("Z1", { status: "done", statusSeq: 1 }),
        rec("Z2"),
        rec("Z3"),
      ];
      if (reopen) {
        const open = p.open();
        for (const r of rows) {
          p.stream(r);
        }
        p.opened(open, rows).commit();
      } else {
        p.list(rows).commit();
      }
      expect(p.panes).not.toContain("Z1");
      expect(p.acks).toEqual([]);
      expect(p.lay.indicators.switchDot).toBe("done");
      expect(p.lay.indicators.attention.count).toBe(1);
    },
  );
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

  it.each([
    ["in a later frame", true],
    ["in the same frame", false],
  ])(
    "shows a clicked tab in the healthy pane after a start failure there, clicked %s",
    (_name, frame) => {
      const p = splitXY();
      p.stream(rec("Z")).commit();
      p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "left", id: "X" }))
        .apply((m) => paneFailed(m, "left"))
        .commit();
      expect([p.panes, p.lay.split.selected]).toEqual([[null, "Z"], "right"]);
      p.stream(endedRec("Y"));
      if (frame) {
        p.commit();
        expect([p.panes, p.lay.split.selected]).toEqual([[null, "Y"], "right"]);
      }
      p.apply((m) => show(m, "X")).commit();
      expect([p.panes, p.lay.split.selected]).toEqual([[null, "X"], "right"]);
    },
  );

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

describe("the repair after a settle that placed nothing", () => {
  function emptyPageBurst(rows: readonly StatusRecord[]): Page {
    const p = bootPage([], null);
    const open = p.open();
    for (const r of rows) {
      p.stream(r);
    }
    p.opened(open, rows).commit();
    return p;
  }

  it.each([
    ["the older session first", ["A", "B"]],
    ["the newer session first", ["B", "A"]],
  ])("shows the first tab of the strip whatever order a burst came in, %s", (_name, order) => {
    const p = emptyPageBurst(order.map((id) => rec(id)));
    expect(p.panes).toEqual(["A", null]);
    expect(p.writes.at(-1)?.record.left).toBe("A");
  });

  it("shows a live session before one the stream reported ended", () => {
    const p = emptyPageBurst([endedRec("A"), rec("B")]);
    expect(p.panes).toEqual(["B", null]);
  });

  it("shows a live session before one whose pane reported a start failure", () => {
    const p = bootPage([], null);
    const open = p.open();
    p.stream(rec("A")).stream(rec("B"));
    p.apply((m) => paneStartFailed(m, "A", "spawn failed"));
    p.opened(open, [rec("A"), rec("B")]).commit();
    expect(p.panes).toEqual(["B", null]);
  });
});

describe("session facts", () => {
  it("keeps a newer status over an older stream record", () => {
    const p = splitXY();
    p.stream(rec("X", { status: "done", statusSeq: 2 }));
    p.stream(rec("X", { status: "working", statusSeq: 1 }));
    expect(p.m.sessions.get("X")?.status).toBe("done");
  });

  it("keeps a tab's alias when a record leaves it out", () => {
    const p = splitXY();
    const { alias: _alias, ...noAlias } = rec("X", { status: "working", statusSeq: 1 });
    p.stream(noAlias);
    expect(p.m.sessions.get("X")?.alias).toBe("X");
  });

  it("adds every session of a list on a page that knew none", () => {
    const p = bootPage([], null);
    p.list([rec("A")]).commit();
    expect(p.m.sessions.has("A")).toBe(true);
    expect(p.requested).toBe(0);
  });

  it("keeps a session a resync dropped from coming back on a stale record", () => {
    const p = splitXY();
    p.apply((m) => resyncBegan(m, ["Y"], false, 0));
    p.stream(rec("Y", { status: "working", statusSeq: 1 }));
    expect(p.m.sessions.has("Y")).toBe(false);
  });

  it("places arrivals after a create that failed", () => {
    const p = splitXY();
    p.apply(createBegan).apply(createFailed);
    p.stream(rec("Z")).commit();
    expect(p.panes).toContain("Z");
  });

  it("places a poll's arrivals the same whatever order the list carried them in", () => {
    const run = (ids: readonly string[]): unknown => {
      const p = splitXY();
      p.list([rec("X"), rec("Y"), ...ids.map((id) => rec(id))]).commit();
      return { panes: p.panes, split: p.lay.split };
    };
    expect(run(["Z2", "Z1"])).toEqual(run(["Z1", "Z2"]));
  });

  it("gives a removed tab's pane to its strip neighbour in the order the user arranged", () => {
    const p = bootPage(["A", "B", "C"], singleRecord("B"));
    p.apply((m) => reorder(m, ["C", "B", "A"])).commit();
    p.apply((m) => removed(m, ["B"], { by: "user" }, 0)).commit();
    expect(p.panes).toEqual(["A", null]);
  });
});

describe("arrivals and start failures", () => {
  it("never covers a session that first appeared ended", () => {
    const p = splitXY();
    p.stream(endedRec("X")).commit();
    p.stream(endedRec("Z")).commit();
    expect(p.panes).toEqual(["X", "Z"]);
    p.stream(rec("W")).commit();
    expect(p.panes).toEqual(["X", "Z"]);
  });

  it("places an arrival removed in the frame it arrived as two frames would", () => {
    const run = (between: boolean): unknown => {
      const p = splitXY();
      p.stream(rec("Z"));
      if (between) {
        p.commit();
      }
      p.gone("Z").commit();
      return { panes: p.panes, split: p.lay.split };
    };
    expect(run(false)).toEqual(run(true));
    expect(run(true)).toEqual({ panes: ["X", null], split: { open: false, selected: "left" } });
  });

  it("keeps the user's new terminal over a failed start when the stream named it before the POST answered", () => {
    const p = splitXY();
    p.apply(createBegan);
    p.stream(rec("N"));
    own(p, "N").commit();
    expect(p.panes).toEqual(["X", "N"]);
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["X", "N"]);
  });

  it("keeps the selection the user moved off a pane a start failure gives back", () => {
    const p = splitXY();
    p.stream(endedRec("X")).commit();
    p.apply((m) => select(m, "right")).commit();
    p.stream(rec("Z")).commit();
    expect(p.panes).toEqual(["X", "Z"]);
    p.apply((m) => select(m, "left")).commit();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    expect(p.lay.split.selected).toBe("left");
  });

  it("announces the tab a late start failure leaves selected when the arrival goes to its chip", () => {
    const p = splitXY();
    p.stream(endedRec("X")).commit();
    p.stream(rec("Z")).commit();
    const fx = p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    expect(fx.focus?.form).toBe("announce");
  });

  it("moves the arrival without an announcement and writes the record when a late start failure keeps it selected", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    const fx = p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
    expect(fx.focus).toBeNull();
    expect(p.writes.at(-1)?.record).toEqual(layoutRecord(p.lay, 0.5));
  });

  it("gives the same panes when both covered sessions fail after the arrivals as before them", () => {
    const first = splitXY();
    first.stream(endedRec("X")).stream(endedRec("Y")).commit();
    first.stream(rec("Z1")).commit();
    first.stream(rec("Z2")).commit();
    const late = splitXY();
    late.stream(rec("Z1")).commit();
    late.stream(rec("Z2")).commit();
    late.stream(endedRec("Y")).commit();
    late.stream(endedRec("X")).commit();
    expect(late.panes).toEqual(first.panes);
  });

  it("leaves a pane the user's address emptied empty when the session an arrival covered there fails", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => route(m, { kind: "split", left: alias("X"), right: null }, false)).commit();
    expect(p.panes).toEqual(["X", null]);
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["X", null]);
  });

  it("keeps a tab the user clicked onto an arrival's pane when the session the arrival covered fails", () => {
    const p = splitXY("W");
    p.stream(rec("Z")).commit();
    p.apply((m) => show(m, "W")).commit();
    expect(p.panes).toEqual(["X", "W"]);
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["X", "W"]);
  });

  it("leaves a pane the kernel dropped empty when the session an arrival covered there fails", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "right", id: "Z" })).commit();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["X", null]);
  });

  it("keeps an arrival when the kernel drops the pane's previous session in the same frame", () => {
    const p = splitXY();
    p.stream(rec("Z"));
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "right", id: "Y" })).commit();
    expect(p.panes).toEqual(["X", "Z"]);
  });
});

describe("reading cues", () => {
  it("keeps a newer ack when the server confirms an older one", () => {
    const p = splitXY();
    p.stream(rec("X", { status: "done", statusSeq: 1 })).commit();
    p.stream(rec("X", { status: "input", statusSeq: 2 })).commit();
    p.apply((m) => ackSettled(m, "X", 1)).commit();
    expect(p.acks).toEqual([
      { id: "X", seq: 1 },
      { id: "X", seq: 2 },
    ]);
  });

  it("keeps a newer ack when an older one fails", () => {
    const p = splitXY();
    p.stream(rec("X", { status: "done", statusSeq: 1 })).commit();
    p.stream(rec("X", { status: "input", statusSeq: 2 })).commit();
    p.apply((m) => ackFailed(m, "X", 1, false)).commit();
    expect(p.acks).toEqual([
      { id: "X", seq: 1 },
      { id: "X", seq: 2 },
    ]);
  });

  it("sends a failed occurrence's ack once when an older ack then succeeds", () => {
    const p = splitXY();
    p.stream(rec("X", { status: "done", statusSeq: 1 })).commit();
    p.stream(rec("X", { status: "input", statusSeq: 2 })).commit();
    p.apply((m) => ackFailed(m, "X", 2, false)).commit();
    p.apply((m) => ackSettled(m, "X", 1)).commit();
    expect(p.acks).toEqual([
      { id: "X", seq: 1 },
      { id: "X", seq: 2 },
    ]);
  });

  it.each([
    ["a click on its chip", (m: TabsModel) => show(m, "X")],
    ["closing the other tab", (m: TabsModel) => removed(m, ["Y"], { by: "user" }, 0)],
    ["closing the split", (m: TabsModel) => splitIntent(m, false)],
    [
      "an address naming it",
      (m: TabsModel) => route(m, { kind: "single", tab: alias("X") }, false),
    ],
    ["a new terminal", (m: TabsModel) => ownCreated(m, rec("N"), null, false)],
    ["a snap", (m: TabsModel) => snap(m, "X", "right", false)],
  ])("re-sends a shown tab's failed seen PUT after %s", (_name, intent) => {
    const p = splitXY();
    p.stream(rec("X", { status: "done", statusSeq: 1 })).commit();
    p.apply((m) => ackFailed(m, "X", 1, false)).commit();
    p.apply(intent).commit();
    expect(p.acks).toEqual([
      { id: "X", seq: 1 },
      { id: "X", seq: 1 },
    ]);
  });

  it("re-sends a hidden tab's failed seen PUT when the tab list opens again", () => {
    const p = splitXY("W");
    p.stream(rec("W", { status: "done", statusSeq: 1 })).commit();
    p.apply((m) => switcherToggled(m, true)).commit();
    p.apply((m) => ackFailed(m, "W", 1, false)).commit();
    p.apply((m) => switcherToggled(m, false)).commit();
    p.apply((m) => switcherToggled(m, true)).commit();
    expect(p.acks).toEqual([
      { id: "W", seq: 1 },
      { id: "W", seq: 1 },
    ]);
  });
});

describe("the layout record", () => {
  it.each([
    ["a click on a hidden tab", (m: TabsModel) => show(m, "W")],
    ["a click on the other pane's tab", (m: TabsModel) => show(m, "Y")],
    ["a new terminal", (m: TabsModel) => ownCreated(m, rec("N"), null, false)],
    ["a snap", (m: TabsModel) => snap(m, "W", "right", false)],
    ["closing the split", (m: TabsModel) => splitIntent(m, false)],
    ["an address", (m: TabsModel) => route(m, { kind: "single", tab: alias("Y") }, false)],
    ["a close", (m: TabsModel) => removed(m, ["Y"], { by: "user" }, 0)],
  ])("writes the record once after %s", (_name, intent) => {
    const p = splitXY("W");
    const before = p.writes.length;
    p.apply(intent).commit();
    expect(p.writes.length).toBe(before + 1);
    expect(p.writes.at(-1)?.record).toEqual(layoutRecord(p.lay, 0.5));
  });

  it("writes nothing for a share the kernel changed", () => {
    const p = splitXY();
    const before = p.writes.length;
    p.apply((m) => splitRatio(m, 0.4, false)).commit();
    expect(p.writes.length).toBe(before);
  });

  it("keeps a 409's owed rewrite through a divider drag", () => {
    const p = splitXY();
    p.apply(layoutStale)
      .apply((m) => splitRatio(m, 0.3, true))
      .commit();
    expect(p.writes.at(-1)).toMatchObject({ owed: "rewrite", record: { handle: 0.3 } });
  });

  it("writes a pane change made during a resync once the resync settles", () => {
    const p = splitXY();
    p.list([rec("R1")]).commit();
    p.apply((m) => select(m, "right")).commit();
    const before = p.writes.length;
    p.resync([rec("R1")], null).commit();
    expect(p.writes.length).toBe(before + 1);
    expect(p.writes.at(-1)?.record.left).toBe("R1");
  });

  it("writes nothing and settles nothing new when the last tab closes", () => {
    const p = bootPage(["X"], singleRecord("X"));
    const before = p.writes.length;
    p.apply((m) => removed(m, ["X"], { by: "user" }, 0)).commit();
    expect(p.writes.length).toBe(before);
    expect(p.resyncs.at(-1)).toEqual([]);
  });

  it.each([
    [
      "a split the record lacks",
      splitRecord("X", "Y"),
      { left: "X", right: "W" },
      { left: "X", right: "W", open: true },
    ],
    [
      "a single view of a split's tab",
      splitRecord("X", null),
      { tab: "X" },
      { left: "X", right: null, open: false },
    ],
  ])("writes the address's layout at boot when it names %s", (_name, record, names, want) => {
    const r: TabRoute =
      "tab" in names
        ? { kind: "single", tab: alias(names.tab) }
        : { kind: "split", left: alias(names.left), right: alias(names.right) };
    const p = bootPage(["X", "Y", "W"], record, { route: r });
    expect(p.writes.at(-1)?.record).toMatchObject(want);
  });

  it("writes nothing at boot for an address when there is no record", () => {
    const p = bootPage(["X", "Y"], null, { route: { kind: "single", tab: alias("Y") } });
    expect(p.panes).toEqual(["Y", null]);
    expect(p.writes).toEqual([]);
  });
});

describe("settling onto the address and the record", () => {
  const split = (left: string | null, right: string | null): TabRoute => ({
    kind: "split",
    left: left === null ? null : alias(left),
    right: right === null ? null : alias(right),
  });

  it.each([
    [
      "W|Y over a record X|Y with the right selected",
      split("W", "Y"),
      splitRecord("X", "Y", "right"),
      "left",
    ],
    [
      "X|W over a record X|Y with the right selected",
      split("X", "W"),
      splitRecord("X", "Y", "right"),
      "left",
    ],
    [
      "X alone over a record X|- with the right selected",
      split("X", null),
      splitRecord("X", null, "right"),
      "left",
    ],
    ["-|Y with no record", split(null, "Y"), null, "right"],
    [
      "X|Y over a record X|Y with the right selected",
      split("X", "Y"),
      splitRecord("X", "Y", "right"),
      "right",
    ],
  ])("selects a shown pane for the address %s", (_name, r, record, selected) => {
    const p = bootPage(["X", "Y", "W"], record, { route: r });
    expect(p.lay.split.selected).toBe(selected);
  });

  it.each([
    ["its selected right side", ["X"], splitRecord("X", "Y", "right"), ["X", null], "left"],
    ["its selected left side", ["Y"], splitRecord("X", "Y", "left"), [null, "Y"], "right"],
  ])(
    "selects the shown pane when the record's %s is gone",
    (_name, rows, record, panes, selected) => {
      const p = bootPage(rows, record);
      expect(p.panes).toEqual(panes);
      expect(p.lay.split.selected).toBe(selected);
    },
  );
});

describe("addresses", () => {
  it.each([
    ["a split with one side named", { left: "X", right: null }, false],
    ["a split naming a closed tab on the right", { left: "X", right: "Q" }, true],
    ["a split naming a closed tab on the left", { left: "Q", right: "X" }, true],
  ])("tells the user about a stale address only for %s", (_name, names, stale) => {
    const p = splitXY();
    const fx = p
      .apply((m) =>
        route(
          m,
          {
            kind: "split",
            left: names.left === null ? null : alias(names.left),
            right: names.right === null ? null : alias(names.right),
          },
          true,
        ),
      )
      .commit();
    expect(fx.toasts.includes("stale")).toBe(stale);
  });

  it.each([
    ["a single view", { kind: "single", tab: alias("Y") } as TabRoute],
    ["the split swapped", { kind: "split", left: alias("Y"), right: alias("X") } as TabRoute],
  ])("moves no focus for an address to %s while a tab is shown", (_name, r) => {
    const fx = splitXY()
      .apply((m) => route(m, r, false))
      .commit();
    expect(fx.focus).toBeNull();
  });

  it("puts no session on a pane that failed", () => {
    const p = splitXY("W");
    p.apply((m) => paneFailed(m, "right")).commit();
    p.apply((m) =>
      route(m, { kind: "split", left: alias("X"), right: alias("W") }, false),
    ).commit();
    expect(p.panes).toEqual(["X", "Y"]);
  });
});

describe("the split", () => {
  it("keeps the other pane's tab when the split closes on an empty selected pane", () => {
    const p = splitXY();
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "left", id: "X" })).commit();
    p.apply((m) => splitIntent(m, false)).commit();
    expect(p.panes).toEqual(["Y", null]);
  });

  it("marks no pane failed while the split is closed", () => {
    const p = bootPage(["X", "Y"], singleRecord("X"));
    p.apply((m) => paneFailed(m, "right")).commit();
    expect(p.lay.failed.right).toBeUndefined();
    p.apply((m) => splitIntent(m, true)).commit();
    expect(p.panes).toEqual(["X", "Y"]);
  });

  it("refuses the split button the window cannot fit", () => {
    const p = bootPage(["X", "Y"], singleRecord("X"), { canOpen: false });
    p.apply((m) => splitIntent(m, true)).commit();
    expect(p.lay.split.open).toBe(false);
  });

  it.each([
    ["onto its own pane", "left", "focus"],
    ["onto the other pane", "right", "announce"],
  ])("focuses or announces a snap of the shown tab %s", (_name, side, form) => {
    const p = bootPage(["X", "Y"], singleRecord("X"));
    const fx = p.apply((m) => snap(m, "X", side as "left" | "right", false)).commit();
    expect(fx.focus?.form).toBe(form);
  });

  it("pairs a split with the tab shown before", () => {
    const p = bootPage(["A", "B", "C"], singleRecord("A"));
    p.apply((m) => show(m, "B")).commit();
    expect(splitPartner(p.m, p.lay, "B")).toBe("A");
  });

  it("keeps the selection on the left of a closed split", () => {
    const p = bootPage([], null);
    p.apply((m) => select(m, "right")).commit();
    expect(p.lay.split.selected).toBe("left");
  });

  it("keeps the selection off an empty pane while another shows a tab", () => {
    const p = splitXY();
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "right", id: "Y" })).commit();
    p.apply((m) => select(m, "right")).commit();
    expect(p.lay.split.selected).toBe("left");
  });

  it("closes the split onto the kept tab, unwritten, when a resync drops the other", () => {
    const p = splitXY();
    const before = p.writes.length;
    const fx = p.apply((m) => resyncBegan(m, ["X"], true, 0)).commit();
    expect(p.panes).toEqual(["Y", null]);
    expect(p.lay.split.open).toBe(false);
    expect(fx.focus?.typing).toBe(true);
    expect(p.writes.length).toBe(before);
  });
});

describe("the strip during a drag", () => {
  it("keeps the dragged order and appends a new tab until the drag ends", () => {
    const p = bootPage(["A", "B"], singleRecord("A"));
    p.apply((m) => dragChanged(m, true)).commit();
    p.apply((m) => reorder(m, ["B", "A"])).commit();
    expect(p.lay.strip).toEqual(["A", "B"]);
    p.stream(rec("Z", { order: -1 })).commit();
    expect(p.lay.strip).toEqual(["A", "B", "Z"]);
    p.gone("B").commit();
    expect(p.lay.strip).toEqual(["A", "Z"]);
  });
});

describe("more placement rules", () => {
  it("requests one resync when a second restart list lands during it", () => {
    const p = splitXY();
    p.list([rec("R1")]).commit();
    p.list([rec("R2")]).commit();
    expect(p.requested).toBe(1);
  });

  it("keeps a 409's owed rewrite through a pane change made during a resync", () => {
    const p = splitXY();
    p.list([rec("R1")]).commit();
    p.apply(layoutStale)
      .apply((m) => select(m, "right"))
      .commit();
    p.resync([rec("R1")], null).commit();
    expect(p.writes.at(-1)?.owed).toBe("rewrite");
  });

  it("pairs a split with the next tab in the order the user arranged when none was shown before", () => {
    const p = bootPage(["A", "B", "C"], singleRecord("A"));
    p.apply((m) => reorder(m, ["A", "C", "B"])).commit();
    expect(splitPartner(p.m, p.lay, "A")).toBe("C");
  });

  it("puts a clicked tab on no selected pane that failed", () => {
    const p = splitXY("W");
    p.apply((m) => select(m, "right"))
      .apply((m) => paneFailed(m, "right"))
      .commit();
    p.apply((m) => show(m, "W")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
  });

  it("puts a new terminal on the other pane when the selected one failed", () => {
    const p = splitXY();
    p.apply((m) => select(m, "right"))
      .apply((m) => paneFailed(m, "right"))
      .commit();
    own(p, "N").commit();
    expect(p.panes).toEqual(["N", "Y"]);
  });

  it("ignores a snap of a tab closed elsewhere before the frame paints it away", () => {
    const p = splitXY("Z");
    p.gone("Z");
    p.apply((m) => snap(m, "Z", "right", false)).commit();
    expect(p.panes).toEqual(["X", "Y"]);
  });

  it("selects the new pane when the split opens beside an empty view", () => {
    const p = bootPage(["X", "Y"], singleRecord("X"));
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "left", id: "X" })).commit();
    p.apply((m) => splitIntent(m, true)).commit();
    expect(p.panes[1]).not.toBeNull();
    expect(p.lay.split.selected).toBe("right");
  });

  it.each([
    ["a single view", { kind: "single", tab: alias("Y") } as TabRoute],
    ["a split", { kind: "split", left: alias("X"), right: alias("Y") } as TabRoute],
  ])("announces the tab an address to %s shows on an empty screen", (_name, r) => {
    const p = bootPage(["X", "Y"], singleRecord("X"));
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "left", id: "X" })).commit();
    const fx = p.apply((m) => route(m, r, false)).commit();
    expect(fx.focus?.form).toBe("announce");
  });

  it("still gives a failed start's pane back after an address that kept the arrival covering it", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) =>
      route(m, { kind: "split", left: alias("X"), right: alias("Z") }, false),
    ).commit();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
  });

  it("shows the burst's first tab when it ends in the frame after the burst, as in the same frame", () => {
    const run = (between: boolean): unknown => {
      const p = bootPage([], null);
      const open = p.open();
      p.stream(rec("A")).stream(rec("B"));
      p.opened(open, [rec("A"), rec("B")]);
      if (between) {
        p.commit();
      }
      p.stream(rec("A", { status: "exited", statusSeq: 1 })).commit();
      return p.panes;
    };
    expect(run(false)).toEqual(run(true));
    expect(run(true)).toEqual(["A", null]);
  });
});

describe("writes of the user's own placements", () => {
  it("writes the neighbour a close of the single view shows", () => {
    const p = bootPage(["X", "Y"], singleRecord("X"));
    const before = p.writes.length;
    p.apply((m) => removed(m, ["X"], { by: "user" }, 0)).commit();
    expect(p.panes).toEqual(["Y", null]);
    expect(p.writes.length).toBe(before + 1);
  });

  it("writes the selection a new terminal moves to its pane when the user already showed it", () => {
    const p = splitXY();
    p.apply(createBegan).stream(rec("N"));
    p.apply((m) => show(m, "N")).commit();
    p.apply((m) => select(m, "right")).commit();
    own(p, "N").commit();
    expect(p.writes.at(-1)?.record).toMatchObject({ left: "N", selected: "left" });
  });

  it("writes the split a snap's new terminal opens", () => {
    const p = bootPage(["X"], singleRecord("X"));
    p.apply(createBegan);
    own(p, "N", { by: "snap", id: "X", side: "right" }).commit();
    expect(p.panes).toEqual(["N", "X"]);
    expect(p.writes.at(-1)?.record).toEqual(layoutRecord(p.lay, 0.5));
  });

  it("writes no record when the kernel empties both panes", () => {
    const p = splitXY();
    const before = p.writes.length;
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "left", id: "X" }));
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "right", id: "Y" })).commit();
    expect(p.writes.length).toBe(before);
  });

  it("does not announce a failed start a late failure leaves selected", () => {
    const p = splitXY();
    p.stream(endedRec("X")).commit();
    p.apply((m) => select(m, "right")).commit();
    p.stream(rec("Z")).commit();
    const fx = p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    expect(fx.focus).toBeNull();
  });

  it("skips a burst's session that ended before the burst was placed", () => {
    const p = bootPage([], null);
    const open = p.open();
    const endedA = rec("A", { status: "exited", statusSeq: 1 });
    p.stream(rec("A")).stream(endedA).stream(rec("B"));
    p.opened(open, [endedA, rec("B")]).commit();
    expect(p.panes).toEqual(["B", null]);
  });
});

describe("start failures learned after several arrivals", () => {
  it("shows both failed starts when the second fails after the first was given back", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => select(m, "right")).commit();
    p.stream(rec("Z2")).commit();
    expect(p.panes).toEqual(["Z2", "Z"]);
    p.stream(endedRec("Y")).commit();
    p.stream(endedRec("X")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
  });

  it("gives an arrival's pane back when it fails to start after a failed start moved it", () => {
    const p = splitXY();
    p.stream(rec("Z1")).commit();
    p.stream(rec("Z2")).commit();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z2", "Y"]);
    p.stream(endedRec("Z1")).commit();
    expect(p.panes).toEqual(["Z1", "Y"]);
  });

  it("keeps an arrival off a pane that failed while a later arrival covered a failed start", () => {
    const p = splitXY();
    p.stream(rec("Z1")).commit();
    p.apply((m) => paneFailed(m, "left")).commit();
    p.stream(rec("Z2")).commit();
    expect(p.panes).toEqual(["X", "Z2"]);
    p.stream(endedRec("Y")).commit();
    expect(p.lay.failed.left).toBe(true);
    expect(p.panes).toEqual(["Z1", "Y"]);
  });
});

describe("a start failure that re-folds a covering arrival's events", () => {
  it("does not show again a stale-address toast an earlier commit showed", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => route(m, { kind: "single", tab: alias("Q") }, true));
    expect(p.commit().toasts).toEqual(["stale"]);
    p.apply((m) => paneStartFailed(m, "Y", "spawn failed"));
    expect(p.commit().toasts).toEqual([]);
    expect(p.panes).toEqual(["Z", "Y"]);
  });

  it("does not take focus again for a keyboard close an earlier commit answered", () => {
    const p = splitXY("W");
    p.stream(rec("Z")).commit();
    p.apply((m) => removed(m, ["W"], { by: "user", keyboardHeld: true }, 0));
    expect(p.commit().focus?.keyboardHeld).toBe(true);
    p.stream(endedRec("Y"));
    expect(p.commit().focus?.keyboardHeld ?? false).toBe(false);
    expect(p.panes).toEqual(["Z", "Y"]);
  });

  it("does not re-send an ack whose only retry already failed", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.stream(rec("Z", { status: "done", statusSeq: 1 }));
    expect(p.commit().acks).toEqual([{ id: "Z", seq: 1 }]);
    p.apply((m) => ackFailed(m, "Z", 1, false));
    expect(p.commit().acks).toEqual([]);
    p.apply(windowFocused);
    expect(p.commit().acks).toEqual([{ id: "Z", seq: 1 }]);
    p.apply((m) => ackFailed(m, "Z", 1, false));
    expect(p.commit().acks).toEqual([]);
    p.stream(endedRec("Y"));
    expect(p.commit().acks).toEqual([]);
    expect(p.panes).toEqual(["Z", "Y"]);
  });

  it("keeps the covering segment's length through hide, show, tray and focus cycles", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.stream(rec("Y", { status: "idle", statusSeq: 1 })).commit();
    const cycle = (): void => {
      p.apply((m) => pageVisibility(m, false)).commit();
      p.apply((m) => pageVisibility(m, true)).commit();
      p.apply((m) => switcherToggled(m, true)).commit();
      p.apply((m) => switcherToggled(m, false)).commit();
      p.apply((m) => splitFit(m, false)).commit();
      p.apply((m) => splitFit(m, true)).commit();
      p.apply(windowFocused).commit();
    };
    cycle();
    const length = p.lay.segment?.events.length;
    for (let i = 0; i < 20; i++) {
      cycle();
    }
    expect(p.lay.segment?.events.length).toBe(length);
    p.stream(endedRec("Y", 2)).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
  });
});

describe("rules the mutation run found unpinned", () => {
  it("forgets a tombstone whose window has passed when the next close is recorded", () => {
    let m = mergeRecord(createModel(), rec("A"), { stream: true }, 0);
    m = mergeRecord(m, rec("B"), { stream: true }, 0);
    m = removed(m, ["A"], { by: "user" }, 0);
    m = removed(m, ["B"], { by: "user" }, CLOSE_TOMBSTONE_MS);
    expect([...m.tombstones.keys()]).toEqual(["B"]);
  });

  it.each([
    ["Z1 first", ["Z1", "Z2"]],
    ["Z2 first", ["Z2", "Z1"]],
  ])(
    "places a reopened stream's arrivals in strip order whatever order the snapshot sent, %s",
    (_name, order) => {
      const p = splitXY();
      const open = p.open();
      for (const id of order) {
        p.stream(rec(id));
      }
      p.opened(open, [rec("X"), rec("Y"), rec("Z1"), rec("Z2")]).commit();
      expect(p.panes).toEqual(["Z2", "Z1"]);
    },
  );

  it("leaves a placed arrival where the user moved it when the stream reopens", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => show(m, "Y")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    const open = p.open();
    p.opened(open, [rec("X"), rec("Y"), rec("Z")]).commit();
    expect(p.panes).toEqual(["X", "Y"]);
  });

  it("does not acknowledge a new occurrence of a hidden tab's status the user read before", () => {
    const p = splitXY("W");
    p.stream(rec("W", { status: "done", statusSeq: 1 })).commit();
    p.apply((m) => show(m, "W")).commit();
    p.apply((m) => show(m, "X")).commit();
    expect(p.panes).toEqual(["X", "Y"]);
    p.stream(rec("W", { status: "done", statusSeq: 2 })).commit();
    expect(p.acks).toEqual([{ id: "W", seq: 1 }]);
    expect(p.lay.indicators.switchDot).toBe("done");
  });

  it("repairs onto a live tab whose status changed, before an ended one", () => {
    const p = bootPage([], null);
    const open = p.open();
    p.stream(endedRec("A"))
      .stream(rec("B"))
      .stream(rec("B", { status: "working", statusSeq: 1 }));
    p.opened(open, [endedRec("A"), rec("B", { status: "working", statusSeq: 1 })]).commit();
    expect(p.panes).toEqual(["B", null]);
  });

  it("keeps a tab's title when a record carries a blank one", () => {
    const p = splitXY();
    p.stream(rec("X", { title: "  " }));
    expect(p.m.sessions.get("X")?.title).toBe("X");
  });

  it("asks for no resync when the server removes a session the page never knew", () => {
    const p = bootPage([], null);
    const before = p.requested;
    p.gone("Q").commit();
    expect(p.requested).toBe(before);
  });

  it("shows the tab after a closed pair when the second of them was shown", () => {
    const p = bootPage(["A", "B", "C", "D", "E"], singleRecord("C"));
    p.apply((m) => removed(m, ["B", "C"], { by: "user" }, 0)).commit();
    expect(p.panes).toEqual(["D", null]);
  });

  it("shows the nearest tab before a closed last tab", () => {
    const p = bootPage(["A", "B", "C"], singleRecord("C"));
    p.apply((m) => removed(m, ["C"], { by: "user" }, 0)).commit();
    expect(p.panes).toEqual(["B", null]);
  });

  it("holds arrivals and a new terminal until a second resync queued during the first settles", () => {
    const p = splitXY();
    p.list([rec("R1")]).commit();
    p.gone("X", "Y").commit();
    expect(p.requested).toBe(2);
    own(p.apply(createBegan), "N");
    p.resync([rec("R1"), rec("N")], null);
    expect(p.m.holds.resync).toBe(1);
    expect(p.m.pendingOwn?.id).toBe("N");
  });

  it("gives an arrival's pane back after the pane it moved to failed between two start failures", () => {
    const p = splitXY();
    p.stream(rec("Z1")).commit();
    p.stream(rec("Z2")).commit();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z2", "Y"]);
    p.apply((m) => paneFailed(m, "left")).commit();
    p.stream(endedRec("Z1")).commit();
    expect(p.panes).toEqual(["Z1", "Y"]);
    expect(p.lay.failed.left).toBe(true);
  });

  it("writes the record when a failed start gets its pane back outside an arrival run", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => select(m, "right")).commit();
    const before = p.writes.length;
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z", "Y"]);
    expect(p.writes.length).toBe(before + 1);
    expect(p.writes.at(-1)?.record).toEqual(layoutRecord(p.lay, 0.5));
  });

  it("does not re-send a failed seen PUT when the server removes a hidden tab", () => {
    const p = splitXY("W");
    p.stream(rec("X", { status: "done", statusSeq: 1 })).commit();
    p.apply((m) => ackFailed(m, "X", 1, false)).commit();
    p.gone("W").commit();
    expect(p.acks).toEqual([{ id: "X", seq: 1 }]);
  });

  it("moves no focus when closing the last tab leaves nothing to show", () => {
    const p = bootPage(["X"], singleRecord("X"));
    const fx = p.apply((m) => removed(m, ["X"], { by: "user" }, 0)).commit();
    expect(fx.focus).toBeNull();
  });

  it("returns the keyboard to a new terminal the user already put on the other pane", () => {
    const p = splitXY();
    p.apply(createBegan).stream(rec("N"));
    p.apply((m) => select(m, "right"))
      .apply((m) => show(m, "N"))
      .commit();
    p.apply((m) => select(m, "left")).commit();
    const fx = own(p, "N").commit();
    expect(p.panes).toEqual(["X", "N"]);
    expect(p.lay.split.selected).toBe("right");
    expect(fx.focus?.form).toBe("focus");
  });

  it("leaves a new terminal on its chip when the only free pane failed", () => {
    const p = splitXY();
    p.apply((m) => select(m, "right")).apply((m) => paneFailed(m, "right"));
    p.apply((m) => shellChanged(m, { kind: "paneDropped", side: "right", id: "Y" })).commit();
    const fx = own(p, "N").commit();
    expect(p.panes).toEqual(["X", null]);
    expect(fx.focus).toBeNull();
  });

  it("toasts a narrow window only for an address asking for a split", () => {
    const narrow = bootPage(["X", "Y"], singleRecord("X"), { canOpen: false });
    const single = narrow
      .apply((m) => route(m, { kind: "single", tab: alias("Y") }, false))
      .commit();
    expect(single.toasts).toEqual([]);
    const wide = splitXY("W");
    const split = wide
      .apply((m) => route(m, { kind: "split", left: alias("X"), right: alias("W") }, false))
      .commit();
    expect(split.toasts).toEqual([]);
    expect(wide.panes).toEqual(["X", "W"]);
  });

  it("gives a failed start its pane back after an address closed the split onto the arrival covering it", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => route(m, { kind: "single", tab: alias("Z") }, false)).commit();
    expect(p.panes).toEqual(["Z", null]);
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Y", null]);
  });

  it("writes the record after an address changes the split", () => {
    const p = splitXY("W");
    const before = p.writes.length;
    p.apply((m) =>
      route(m, { kind: "split", left: alias("X"), right: alias("W") }, false),
    ).commit();
    expect(p.writes.length).toBe(before + 1);
    expect(p.writes.at(-1)?.record).toEqual(layoutRecord(p.lay, 0.5));
  });
});

describe("rules the second mutation run found unpinned", () => {
  it("acknowledges no occurrence the user never saw, in one frame", () => {
    const p = splitXY("W");
    p.stream(rec("W", { status: "done", statusSeq: 1 }));
    p.apply((m) => show(m, "W")).apply((m) => show(m, "X"));
    p.stream(rec("W", { status: "done", statusSeq: 2 })).commit();
    expect(p.acks).toEqual([]);
    expect(p.lay.indicators.switchDot).toBe("done");
  });

  it("pairs a split with the first tab of the strip when nothing was shown yet", () => {
    let m = createModel();
    for (const id of ["A", "B", "C"]) {
      m = mergeRecord(m, rec(id), { stream: true }, 0);
    }
    expect(splitPartner(m, EMPTY_LAYOUT, null)).toBe("A");
  });

  it("keeps an arrival off a failed pane after a click on a tab closed elsewhere", () => {
    const p = splitXY("Q");
    p.stream(rec("Z1")).commit();
    p.apply((m) => paneFailed(m, "left")).commit();
    p.gone("Q").commit();
    p.apply((m) => show(m, "Q"));
    p.stream(rec("Z2")).commit();
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Z1", "Y"]);
  });

  it("gives a failed start its pane back after an address to the arrival closed the split from the other pane", () => {
    const p = splitXY();
    p.stream(rec("Z")).commit();
    p.apply((m) => select(m, "left")).commit();
    p.apply((m) => route(m, { kind: "single", tab: alias("Z") }, false)).commit();
    expect(p.panes).toEqual(["Z", null]);
    p.stream(endedRec("Y")).commit();
    expect(p.panes).toEqual(["Y", null]);
  });

  it("places no new terminal that was closed while a resync held it", () => {
    const p = splitXY();
    p.list([rec("R1")]).commit();
    const ids = p.resyncs.shift() ?? [];
    p.apply((m) => resyncBegan(m, ids, false, 0));
    own(p.apply(createBegan), "N");
    p.gone("N");
    p.apply((m) =>
      resyncSettled(m, {
        sessions: [rec("R1")],
        record: null,
        route: null,
        toastStale: false,
        now: 0,
      }),
    );
    p.apply(ownReleased).commit();
    expect(p.panes).toEqual(["R1", null]);
  });
});

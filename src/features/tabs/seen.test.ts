// Which cues a session's readers have seen is server state: every page folds the
// server's occurrence number against its seen floor, and a read on one page
// clears the dot, count, badge and banner on every other.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionsServer,
  until,
  type Page,
  type SessionsServer,
} from "./test-helpers/sessions-server.js";

let server: SessionsServer;

beforeEach(() => {
  server = createSessionsServer();
  server.add("x", "ex");
  server.add("y", "why");
});

afterEach(() => {
  server.destroy();
  vi.restoreAllMocks();
});

const counted = (p: Page): boolean => p.doc.title.startsWith("(");

async function settle(p: Page, pred: () => boolean = () => false): Promise<void> {
  await until(pred, pred() ? 1 : 30);
  await until(() => false, 3);
  void p;
}

/** x is unread on both pages, both hidden; B shows y, A shows x. */
async function twoPagesUnread(notify = false): Promise<{ a: Page; b: Page }> {
  const a = await server.open();
  const b = await server.open();
  b.show(1);
  a.setVisible(false);
  b.setVisible(false);
  if (notify) {
    server.notify("x", "Task finished", "done");
  } else {
    server.setStatus("x", "done");
  }
  await settle(a);
  expect(a.badge(), "A counts the cue").toBe(1);
  expect(b.badge(), "B counts the cue").toBe(1);
  return { a, b };
}

describe("a read on one page clears the cue on every page", () => {
  it("clears the other page's badge, banner and switch dot", async () => {
    const { a, b } = await twoPagesUnread(true);
    expect(b.banners.map((n) => [n.tag, n.closed])).toEqual([["x", false]]);
    expect(b.switchDot()).toBe("done");

    a.setVisible(true);
    await settle(b, () => b.badge() === 0);

    expect(a.puts).toEqual([{ id: "x", seq: 1 }]);
    expect(b.badge()).toBe(0);
    expect(counted(b)).toBe(false);
    expect(b.banners[0]?.closed).toBe(true);
    expect(b.switchDot()).toBe("");
  });

  it("closes the other page's banner and switch dot for a done held by background activity", async () => {
    const { a, b } = await twoPagesUnread(true);
    server.setActivity("x", "working");
    await settle(b);
    expect(b.badge(), "the held done counts nothing").toBe(0);
    expect(b.banners[0]?.closed).toBe(false);

    a.setVisible(true);
    await settle(b, () => b.banners[0]?.closed === true);
    expect(a.puts).toEqual([{ id: "x", seq: 1 }]);
    expect(b.banners[0]?.closed).toBe(true);
    expect(b.switchDot()).toBe("");
  });

  it("keeps the surfaces raised for a newer occurrence when an older one is read", async () => {
    const b = await server.open();
    b.show(1);
    b.setVisible(false);
    server.setStatus("x", "done");
    server.notify("x", "Approval needed", "input");
    await settle(b);
    expect(b.switchDot()).toBe("input");
    expect(b.banners.map((n) => n.closed)).toEqual([false]);

    server.ack("x", 1);
    await settle(b);
    expect(b.banners[0]?.closed, "a read of done leaves the input banner").toBe(false);
    expect(b.switchDot()).toBe("input");
    expect(b.badge()).toBe(1);

    server.ack("x", 2);
    await settle(b);
    expect(b.banners[0]?.closed).toBe(true);
    expect(b.switchDot()).toBe("");
    expect(b.badge()).toBe(0);
  });
});

describe("the seen floor only rises", () => {
  it("never lets a lagging page hide a newer cue", async () => {
    const a = await server.open();
    const b = await server.open();
    a.show(1);
    a.setVisible(false);
    b.setVisible(false);
    server.setStatus("x", "done");
    await settle(b);
    b.holdStream();
    server.setStatus("x", "working");
    server.setStatus("x", "done");
    await settle(a);
    expect(server.session("x").statusSeq).toBe(3);
    expect(a.badge()).toBe(1);

    b.setVisible(true);
    await settle(b, () => b.puts.length === 1);
    expect(b.puts).toEqual([{ id: "x", seq: 1 }]);
    expect(server.session("x").seenSeq).toBe(1);
    await settle(a);
    expect(a.badge(), "the newer done stays unread elsewhere").toBe(1);
  });

  it("stays read when an older ack's 204 lands after a newer read", async () => {
    const a = await server.open();
    const b = await server.open();
    a.show(1);
    a.setVisible(false);
    b.holdPuts();
    server.setStatus("x", "done");
    await settle(b, () => b.puts.length === 1);
    b.setVisible(false);
    server.setStatus("x", "working");
    server.setStatus("x", "done");
    await settle(b);
    expect(b.badge()).toBe(1);

    server.ack("x", 3);
    await settle(b);
    expect(b.badge()).toBe(0);
    await b.releasePut(204);
    // A record carrying no seen floor repaints from the page's own.
    b.deliver({ id: "x", title: "ex", createdAt: "1", status: "done", statusSeq: 3 });
    await settle(b);
    expect(b.badge()).toBe(0);
    expect(counted(b)).toBe(false);
  });

  it("ignores a list that predates the stream, with a lower occurrence", async () => {
    const a = await server.open();
    a.show(1);
    a.setVisible(false);
    server.setStatus("x", "done");
    server.ack("x", 1);
    a.holdLists();
    a.reopen();
    await settle(a); // the list is requested before the stream moves on
    server.setStatus("x", "working");
    server.setStatus("x", "done");
    await settle(a);
    expect(a.badge()).toBe(1);
    await a.releaseList();
    await settle(a);
    expect(a.badge(), "the stale list does not hide the newer done").toBe(1);

    a.setVisible(true);
    a.show(0);
    await settle(a, () => a.puts.length > 0);
    expect(a.puts.at(-1)).toEqual({ id: "x", seq: 3 });
  });

  it("ignores a list that predates the stream at the same occurrence", async () => {
    const a = await server.open();
    a.show(1);
    a.setVisible(false);
    server.setActivity("x", "working");
    server.setStatus("x", "done");
    a.holdLists();
    a.reopen();
    await settle(a); // the list is requested before the stream moves on
    server.setActivity("x", "");
    await settle(a);
    expect(a.badge()).toBe(1);
    await a.releaseList();
    await settle(a);
    expect(a.badge(), "the held activity does not come back from the old list").toBe(1);
  });

  it("does not relight a read cue from a record with a lower seen floor", async () => {
    const a = await server.open();
    a.show(1);
    a.setVisible(false);
    server.setStatus("x", "done");
    server.ack("x", 1);
    await settle(a);
    expect(a.badge()).toBe(0);
    a.deliver({ id: "x", title: "ex", createdAt: "1", status: "done", statusSeq: 1, seenSeq: 0 });
    await settle(a);
    expect(a.badge()).toBe(0);
    expect(counted(a)).toBe(false);
  });
});

describe("this page's own ack", () => {
  /** One page, visible, showing x, with the server failing its acks. */
  async function failing(answer: 500 | 404): Promise<Page> {
    const a = await server.open();
    a.putAnswer = answer;
    return a;
  }

  it("brings the dot back after a 500 and re-sends on the next visibilitychange", async () => {
    const a = await failing(500);
    server.setStatus("x", "done");
    await settle(a, () => a.badge() === 1);
    expect(a.badge()).toBe(1);
    a.putAnswer = 204;
    a.setVisible(true);
    await settle(a, () => a.badge() === 0);
    expect(a.puts).toEqual([
      { id: "x", seq: 1 },
      { id: "x", seq: 1 },
    ]);
    expect(a.badge()).toBe(0);
  });

  it("stays clear when the server applied the ack and only the response failed", async () => {
    const a = await failing(500);
    a.putAnswer = "apply-then-500";
    server.setStatus("x", "done");
    await settle(a);
    expect(server.session("x").seenSeq).toBe(1);
    expect(a.badge()).toBe(0);
    expect(counted(a)).toBe(false);
  });

  it("stays clear when another device's read lands while this ack is in flight and then fails", async () => {
    const a = await server.open();
    a.holdPuts();
    server.setStatus("x", "done");
    await settle(a, () => a.puts.length === 1);
    server.ack("x", 1);
    await a.releasePut(500);
    await settle(a);
    expect(a.badge()).toBe(0);
    expect(counted(a)).toBe(false);
  });

  it("keeps a newer ack's floor when an older ack fails", async () => {
    const a = await server.open();
    a.holdPuts();
    server.setStatus("x", "done");
    server.setStatus("x", "working");
    server.setStatus("x", "done");
    await settle(a, () => a.puts.length === 2);
    expect(a.puts).toEqual([
      { id: "x", seq: 1 },
      { id: "x", seq: 3 },
    ]);
    await a.releasePut(500);
    await settle(a);
    expect(a.badge(), "ack 3 is still in flight").toBe(0);
    expect(counted(a)).toBe(false);
    await a.releasePut(204);
    await settle(a);
    expect(a.badge()).toBe(0);
    expect(counted(a)).toBe(false);
  });

  it("sends one automatic PUT per occurrence while the server fails, and retries at the sync points", async () => {
    const a = await failing(500);
    server.setStatus("x", "done");
    await settle(a);
    for (let i = 1; i < 10; i++) {
      a.deliver({
        id: "x",
        title: `ex ${String(i)}`,
        createdAt: "1",
        status: "done",
        statusSeq: 1,
      });
      await settle(a);
    }
    expect(a.puts, "one PUT for ten records of one occurrence").toHaveLength(1);
    a.setVisible(true);
    await settle(a, () => a.puts.length === 2);
    expect(a.puts).toHaveLength(2);
    a.reopen();
    await settle(a, () => a.puts.length === 3);
    expect(a.puts).toHaveLength(3);
    server.notify("x", "Approval needed", "input");
    await settle(a, () => a.puts.length === 4);
    expect(a.puts.at(-1)).toEqual({ id: "x", seq: 2 });
  });

  it("warns once per page for repeated failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await failing(500);
    for (let seq = 1; seq <= 3; seq++) {
      a.deliver({
        id: "x",
        title: "ex",
        createdAt: "1",
        status: seq % 2 === 0 ? "input" : "done",
        statusSeq: seq,
      });
      await settle(a, () => a.puts.length === seq);
    }
    await settle(a);
    expect(a.puts).toHaveLength(3);
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("marking a session read")),
    ).toHaveLength(1);
  });

  it("leaves the dot clear after a 404 and sends nothing more", async () => {
    const a = await failing(404);
    server.setStatus("x", "done");
    await settle(a);
    expect(a.badge()).toBe(0);
    a.setVisible(true);
    a.win.dispatchEvent(new a.win.Event("focus"));
    await settle(a);
    expect(a.puts).toHaveLength(1);
    expect(a.badge()).toBe(0);
  });

  it("never counts a cue landing on the watched tab, even before the server answers", async () => {
    const a = await server.open();
    a.holdPuts();
    const before = a.badgeWrites.length;
    server.setStatus("x", "done");
    await settle(a, () => a.puts.length === 1);
    await settle(a);
    expect(a.badgeWrites.slice(before).every((n) => n === 0)).toBe(true);
    expect(counted(a)).toBe(false);
  });

  it("clears its own switch dot when the 204 lands before the broadcast", async () => {
    const a = await server.open();
    a.setVisible(false);
    server.setStatus("x", "done");
    await settle(a);
    expect(a.switchDot()).toBe("done");
    a.holdStream();
    a.setVisible(true);
    await settle(a, () => a.puts.length === 1);
    await settle(a);
    expect(a.switchDot(), "cleared on the read itself").toBe("");
    a.releaseStream();
    await settle(a);
    expect(a.switchDot()).toBe("");
  });

  it("clears its own switch dot when the broadcast lands before the 204", async () => {
    const a = await server.open();
    a.setVisible(false);
    server.setStatus("x", "done");
    await settle(a);
    a.holdPuts();
    a.setVisible(true);
    await settle(a, () => a.puts.length === 1);
    server.ack("x", 1);
    await settle(a);
    expect(a.switchDot()).toBe("");
    await a.releasePut(204);
    expect(a.switchDot()).toBe("");
  });

  it("retries a failed ack when the window regains focus", async () => {
    const a = await failing(500);
    server.setStatus("x", "done");
    await settle(a, () => a.badge() === 1);
    a.putAnswer = 204;
    a.win.dispatchEvent(new a.win.Event("focus"));
    await settle(a, () => a.badge() === 0);
    expect(a.puts).toHaveLength(2);
    expect(a.badge()).toBe(0);
    expect(counted(a)).toBe(false);
  });
});

describe("the boot list carries the server's numbers", () => {
  it("counts nothing for a cue already read on another device", async () => {
    server.setStatus("y", "done");
    server.ack("y", 1);
    const a = await server.open({ holdStream: true });
    await settle(a);
    expect(a.badge()).toBe(0);
    expect(counted(a)).toBe(false);
  });

  it("counts a cue no device has read", async () => {
    server.setStatus("y", "done");
    const a = await server.open({ holdStream: true });
    await settle(a, () => a.badge() === 1);
    expect(a.badge()).toBe(1);
    expect(a.doc.title.startsWith("(1) ")).toBe(true);
  });
});

describe("a malformed occurrence number", () => {
  it("leaves the tab's number unchanged", async () => {
    const a = await server.open();
    a.show(1);
    a.setVisible(false);
    server.setStatus("x", "done");
    await settle(a);
    expect(a.badge()).toBe(1);
    for (const bad of ["3", -1, 1.5, 2 ** 53]) {
      a.deliver({
        id: "x",
        title: "ex",
        createdAt: "1",
        status: "done",
        statusSeq: bad as number,
        seenSeq: bad as number,
      });
      await settle(a);
      expect(a.badge(), String(bad)).toBe(1);
    }
    a.setVisible(true);
    a.show(0);
    await settle(a, () => a.puts.length === 1);
    expect(a.puts).toEqual([{ id: "x", seq: 1 }]);
  });
});

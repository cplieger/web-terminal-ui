import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import type { TerminalContext } from "../kernel/types.js";
import type { activityMonitor as ActivityMonitorFn } from "./activity-monitor.js";

const close = vi.fn();
let captured: ((s: SessionStatus) => void) | undefined;
let capturedOpen: (() => void) | undefined;
const connectStatusStream = vi.fn(
  (_path: string, cb: { onStatus: (s: SessionStatus) => void; onOpen?: () => void }) => {
    captured = cb.onStatus;
    capturedOpen = cb.onOpen;
    return { close };
  },
);

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return { ...actual, connectStatusStream };
});

// activityMonitor.setup ignores its ctx (it reads only opts.eventsPath), so a
// bare cast is a safe stand-in for this unit test.
const ctx = {} as unknown as TerminalContext;

const status = (id: string, extra: Partial<SessionStatus> = {}): SessionStatus => ({
  id,
  status: "working",
  title: "",
  createdAt: "2026-01-01T00:00:00Z",
  ...extra,
});

let activityMonitor: typeof ActivityMonitorFn;

beforeEach(async () => {
  vi.resetModules();
  connectStatusStream.mockClear();
  close.mockClear();
  captured = undefined;
  capturedOpen = undefined;
  ({ activityMonitor } = await import("./activity-monitor.js"));
});

describe("activityMonitor: status map + fan-out", () => {
  it("records each session's latest status and returns it from current()", async () => {
    const inst = await activityMonitor().setup(ctx);
    captured?.(status("s1", { status: "idle" }));
    expect(inst.api?.current("s1")?.status).toBe("idle");
    captured?.(status("s1", { status: "working" }));
    expect(inst.api?.current("s1")?.status).toBe("working");
    expect(inst.api?.current("absent")).toBeUndefined();
  });

  it("fans every status event out to all subscribers", async () => {
    const inst = await activityMonitor().setup(ctx);
    const seen: string[] = [];
    inst.api?.onStatus((s) => seen.push(`a:${s.id}`));
    inst.api?.onStatus((s) => seen.push(`b:${s.id}`));
    captured?.(status("s1"));
    expect(seen).toEqual(["a:s1", "b:s1"]);
  });

  it("drops a session from current() when a removed event arrives", async () => {
    const inst = await activityMonitor().setup(ctx);
    captured?.(status("s1"));
    expect(inst.api?.current("s1")).toBeDefined();
    captured?.(status("s1", { removed: true }));
    expect(inst.api?.current("s1")).toBeUndefined();
  });

  it("the onStatus unsubscribe stops further delivery", async () => {
    const inst = await activityMonitor().setup(ctx);
    let calls = 0;
    const off = inst.api?.onStatus(() => {
      calls++;
    });
    captured?.(status("s1"));
    off?.();
    captured?.(status("s1"));
    expect(calls).toBe(1);
  });

  it("teardown closes the stream and clears state", async () => {
    const inst = await activityMonitor().setup(ctx);
    captured?.(status("s1"));
    inst.teardown();
    expect(close).toHaveBeenCalledTimes(1);
    expect(inst.api?.current("s1")).toBeUndefined();
  });
});

describe("activityMonitor: subscriber isolation", () => {
  it("isolates a throwing subscriber: peers still run and the throw never propagates", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inst = await activityMonitor().setup(ctx);
    let bCalled = false;
    inst.api?.onStatus(() => {
      throw new Error("boom");
    });
    inst.api?.onStatus(() => {
      bCalled = true;
    });
    // Must not throw out of the engine's onStatus callback (the SSE reader).
    captured?.(status("s1"));
    expect(bCalled).toBe(true);
    expect(inst.api?.current("s1")).toBeDefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});

describe("activityMonitor: stream-open fan-out (restart reconcile hook)", () => {
  it("notifies open subscribers on every stream (re)open", async () => {
    const inst = await activityMonitor().setup(ctx);
    let opens = 0;
    inst.api?.onStreamOpen?.(() => {
      opens++;
    });
    capturedOpen?.(); // initial connect
    capturedOpen?.(); // reconnect (e.g. after a manager restart)
    expect(opens).toBe(2);
  });

  it("catches a late subscriber up when the stream already opened", async () => {
    const inst = await activityMonitor().setup(ctx);
    capturedOpen?.(); // stream opens before anyone subscribes
    let opens = 0;
    inst.api?.onStreamOpen?.(() => {
      opens++;
    });
    expect(opens).toBe(1); // immediate catch-up
    capturedOpen?.();
    expect(opens).toBe(2);
  });

  it("the onStreamOpen unsubscribe stops further delivery", async () => {
    const inst = await activityMonitor().setup(ctx);
    capturedOpen?.();
    let opens = 0;
    const off = inst.api?.onStreamOpen?.(() => {
      opens++;
    });
    off?.();
    capturedOpen?.();
    expect(opens).toBe(1); // only the catch-up call
  });

  it("isolates a throwing open subscriber from its peers", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inst = await activityMonitor().setup(ctx);
    let peerRan = false;
    inst.api?.onStreamOpen?.(() => {
      throw new Error("boom");
    });
    inst.api?.onStreamOpen?.(() => {
      peerRan = true;
    });
    capturedOpen?.();
    expect(peerRan).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe("activityMonitor: teardown releases the subscribers", () => {
  // stream.close() stops the SSE reader, but an event already handed to the
  // callback is in flight and arrives afterwards; and the consumer (tabs) holds
  // its subscription across a whole page lifetime. So teardown drops the
  // subscriber sets rather than trusting the transport to fall silent, which is
  // what keeps a torn-down feature from calling back into a torn-down consumer.
  it("delivers no status to a subscriber registered before teardown", async () => {
    const inst = await activityMonitor().setup(ctx);
    const seen: string[] = [];
    inst.api?.onStatus((s) => seen.push(s.id));
    captured?.(status("before"));
    expect(seen).toEqual(["before"]);

    inst.teardown();
    captured?.(status("after"));

    expect(seen).toEqual(["before"]);
  });

  it("delivers no stream-open signal to a subscriber registered before teardown", async () => {
    // The open signal is the one that makes tabs run a full GET /api/sessions
    // reconcile, so a late one against a torn-down consumer is a request nobody
    // asked for, against state nobody owns any more.
    const inst = await activityMonitor().setup(ctx);
    const opens = vi.fn();
    inst.api?.onStreamOpen?.(opens);
    capturedOpen?.();
    expect(opens).toHaveBeenCalledTimes(1);

    inst.teardown();
    capturedOpen?.();

    expect(opens).toHaveBeenCalledTimes(1);
  });
});

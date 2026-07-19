import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { createConnState, type ConnStateMachine } from "./conn-state.js";
import type { ConnState } from "./types.js";

let onState: Mock<(s: ConnState) => void>;
let onGiveUp: Mock<() => void>;
let m: ConnStateMachine;

beforeEach(() => {
  vi.useFakeTimers();
  onState = vi.fn<(s: ConnState) => void>();
  onGiveUp = vi.fn<() => void>();
  m = createConnState({ onState, onGiveUp });
});
afterEach(() => {
  m.destroy();
  vi.useRealTimers();
});

const states = (): ConnState[] => onState.mock.calls.map((c) => c[0]);

describe("conn-state: initial + open", () => {
  it("starts in 'connecting' and emits nothing until a transition", () => {
    expect(m.current()).toBe("connecting");
    expect(onState).not.toHaveBeenCalled();
  });

  it("open() moves to 'open' immediately", () => {
    m.open();
    expect(m.current()).toBe("open");
    expect(states()).toEqual(["open"]);
  });
});

describe("conn-state: transient states suppressed until the first frame", () => {
  it("reconnecting() is a no-op before load (the loading overlay owns the screen)", () => {
    m.reconnecting();
    vi.advanceTimersByTime(1000);
    expect(onState).not.toHaveBeenCalled();
  });

  it("the first three failed initial connects stay silent (no banner, no give-up)", () => {
    m.closed();
    m.closed();
    m.closed();
    vi.advanceTimersByTime(1000);
    expect(onState).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("the fourth failed initial connect gives up and surfaces 'offline' through the overlay", () => {
    m.closed();
    m.closed();
    m.closed();
    m.closed();
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600);
    expect(states()).toEqual(["offline"]);
  });
});

describe("conn-state: loaded lifecycle", () => {
  beforeEach(() => {
    m.setLoaded();
  });

  it("reconnecting() shows 'reconnecting' only after the grace delay", () => {
    m.reconnecting();
    vi.advanceTimersByTime(599);
    expect(onState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(states()).toEqual(["reconnecting"]);
  });

  it("escalates to 'offline' after more than three consecutive closes", () => {
    m.closed();
    m.closed();
    m.closed();
    vi.advanceTimersByTime(600);
    m.closed();
    vi.advanceTimersByTime(600);
    expect(states().at(-1)).toBe("offline");
  });

  it("open() within the grace window cancels a pending 'reconnecting'", () => {
    m.reconnecting();
    vi.advanceTimersByTime(300);
    m.open();
    vi.advanceTimersByTime(600);
    expect(states()).toEqual(["open"]);
  });
});

describe("conn-state: restarted auto-clears", () => {
  beforeEach(() => {
    m.setLoaded();
  });

  it("shows 'restarted' immediately then returns to 'open' after the clear delay", () => {
    m.restarted();
    expect(states()).toEqual(["restarted"]);
    vi.advanceTimersByTime(4000);
    expect(states()).toEqual(["restarted", "open"]);
  });
});

describe("conn-state: restarted timer edges", () => {
  beforeEach(() => {
    m.setLoaded();
  });

  it("a second restarted() resets the auto-clear timer instead of leaking the first", () => {
    m.restarted();
    vi.advanceTimersByTime(3000);
    m.restarted();
    vi.advanceTimersByTime(3000);
    expect(m.current()).toBe("restarted");
    vi.advanceTimersByTime(1000);
    expect(m.current()).toBe("open");
  });

  it("a newer state inside the restarted window is not clobbered by the stale auto-revert", () => {
    m.restarted();
    vi.advanceTimersByTime(1000);
    m.reconnecting();
    vi.advanceTimersByTime(600);
    expect(m.current()).toBe("reconnecting");
    vi.advanceTimersByTime(2400);
    expect(m.current()).toBe("reconnecting");
  });
});

describe("conn-state: ended (definitive process exit)", () => {
  it("shows 'ended' immediately once loaded, with no grace delay", () => {
    m.setLoaded();
    m.ended();
    expect(states()).toEqual(["ended"]);
    expect(m.current()).toBe("ended");
  });

  it("passes through the loading gate: an exit before the first frame still surfaces", () => {
    // The active session died before rendering anything (attach to an
    // already-dead session). "ended" is the only explanation the page will
    // ever get, so unlike the transient states it must not be suppressed.
    m.ended();
    expect(states()).toEqual(["ended"]);
  });

  it("persists (no auto-clear) until open() replaces it on a switch to a live session", () => {
    m.setLoaded();
    m.ended();
    vi.advanceTimersByTime(60_000);
    expect(m.current()).toBe("ended");
    m.open();
    expect(m.current()).toBe("open");
  });

  it("resets the failure streak so a later live session starts escalation from zero", () => {
    m.setLoaded();
    m.closed();
    m.closed();
    m.closed(); // streak at 3; one more close would escalate to offline
    m.ended(); // definitive end resets the streak
    m.closed();
    vi.advanceTimersByTime(600);
    expect(m.current()).toBe("reconnecting"); // not "offline": the streak restarted
  });
});

describe("conn-state: destroy clears pending timers", () => {
  beforeEach(() => {
    m.setLoaded();
  });

  it("a pending reconnecting timer does not fire after destroy()", () => {
    m.reconnecting();
    m.destroy();
    vi.advanceTimersByTime(1000);
    expect(onState).not.toHaveBeenCalled();
  });

  it("a pending restarted auto-clear does not fire after destroy()", () => {
    m.restarted();
    onState.mockClear();
    m.destroy();
    vi.advanceTimersByTime(4000);
    expect(onState).not.toHaveBeenCalled();
  });
});

describe("conn-state: incompatible wire revision", () => {
  it("passes through the loading gate and persists without a retry timer", () => {
    m.incompatible();
    expect(states()).toEqual(["incompatible"]);
    vi.advanceTimersByTime(60_000);
    expect(m.current()).toBe("incompatible");
  });

  it("is replaced only when a later connection opens", () => {
    m.setLoaded();
    m.incompatible();
    m.open();
    expect(states()).toEqual(["incompatible", "open"]);
  });
});

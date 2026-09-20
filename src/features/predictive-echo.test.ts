import { describe, it, expect, vi } from "vitest";
import { predictiveEcho } from "./predictive-echo.js";
import type { TerminalContext, FeatureInstance } from "../kernel/types.js";

function fakeCtx(size = { cols: 80, rows: 30 }): {
  ctx: TerminalContext;
  setPredictedCursor: ReturnType<typeof vi.fn>;
  deferred: (() => void)[];
  transform: (b: Uint8Array) => Uint8Array;
  observe: (b: Uint8Array) => void;
  emit: (e: string, p: unknown) => void;
} {
  let transformFn: ((b: Uint8Array) => Uint8Array) | undefined;
  let observerFn: ((b: Uint8Array) => void) | undefined;
  const handlers = new Map<string, (p: unknown) => void>();
  const deferred: (() => void)[] = [];
  const setPredictedCursor = vi.fn();
  const ctx = {
    registerInputTransform: (fn: (b: Uint8Array) => Uint8Array) => {
      transformFn = fn;
      return vi.fn();
    },
    registerInputObserver: (fn: (b: Uint8Array) => void) => {
      observerFn = fn;
      return vi.fn();
    },
    on: (e: string, fn: (p: unknown) => void) => {
      handlers.set(e, fn);
      return vi.fn();
    },
    defer: (release: () => void) => {
      deferred.push(release);
    },
    render: { setPredictedCursor },
    session: { size: () => size },
  } as unknown as TerminalContext;
  return {
    ctx,
    setPredictedCursor,
    deferred,
    transform: (b) => transformFn?.(b) ?? b,
    observe: (b) => observerFn?.(b),
    emit: (e, p) => handlers.get(e)?.(p),
  };
}

// Arm prediction at a known (row,col) by feeding a server screen frame, exactly
// as the kernel would on the first paint.
function arm(f: ReturnType<typeof fakeCtx>, row: number, col: number): void {
  f.emit("wire:screen", { cursor: [row, col], cursorHidden: false });
}

const DEL = 0x7f;

describe("predictiveEcho: col-0 backspace brake (input transform)", () => {
  it("drops a lone DEL at the true origin (0,0) while prediction is active", () => {
    const f = fakeCtx();
    predictiveEcho().setup(f.ctx);
    arm(f, 0, 0);
    expect(f.transform(new Uint8Array([DEL])).length).toBe(0);
  });

  it("passes a DEL through when the predicted cursor is not at column 0", () => {
    const f = fakeCtx();
    predictiveEcho().setup(f.ctx);
    arm(f, 0, 5);
    const out = f.transform(new Uint8Array([DEL]));
    expect(Array.from(out)).toEqual([DEL]);
  });

  it("passes a DEL through when prediction is inactive (no server frame yet)", () => {
    const f = fakeCtx();
    predictiveEcho().setup(f.ctx);
    const out = f.transform(new Uint8Array([DEL]));
    expect(Array.from(out)).toEqual([DEL]);
  });

  it("passes a multi-byte input through even at (0,0)", () => {
    const f = fakeCtx();
    predictiveEcho().setup(f.ctx);
    arm(f, 0, 0);
    const out = f.transform(new Uint8Array([DEL, DEL]));
    expect(Array.from(out)).toEqual([DEL, DEL]);
  });

  it("passes a non-DEL single byte through at (0,0)", () => {
    const f = fakeCtx();
    predictiveEcho().setup(f.ctx);
    arm(f, 0, 0);
    const out = f.transform(new Uint8Array([0x08]));
    expect(Array.from(out)).toEqual([0x08]);
  });
  it("passes a DEL through at column 0 of any row but the first", () => {
    // The brake is for the TRUE origin only: at col 0 further down the screen a
    // backspace is a line join the shell has to see, not a keypress against an
    // empty first line.
    const f = fakeCtx();
    predictiveEcho().setup(f.ctx);
    arm(f, 2, 0);
    const out = f.transform(new Uint8Array([DEL]));
    expect(Array.from(out)).toEqual([DEL]);
  });
});

describe("predictiveEcho: prediction wiring", () => {
  it("re-pushes the predicted cursor after a render flush", () => {
    // The renderer rebuilds its overlay on every flush, so the prediction has to
    // be re-asserted or the ghost cursor disappears until the next keypress.
    const f = fakeCtx();
    predictiveEcho().setup(f.ctx);
    arm(f, 0, 3);
    f.setPredictedCursor.mockClear();

    f.emit("render:cursor", undefined);

    expect(f.setPredictedCursor).toHaveBeenCalledWith(0, 3, true);
  });

  it("gives the predictor the session's own width, so a prediction wraps where the screen does", () => {
    // Predicting against a default 80 columns on a 4-column screen puts the ghost
    // cursor off the end of the row instead of at the start of the next one.
    const f = fakeCtx({ cols: 4, rows: 2 });
    predictiveEcho().setup(f.ctx);
    arm(f, 0, 3); // the last column: the next character wraps
    f.observe(new Uint8Array([0x41]));
    f.observe(new Uint8Array([0x42]));
    expect(f.setPredictedCursor).toHaveBeenLastCalledWith(1, 1, true);
  });

  it("advances the predicted cursor for observed printable input", () => {
    const f = fakeCtx();
    predictiveEcho().setup(f.ctx);
    arm(f, 0, 0);
    f.setPredictedCursor.mockClear();
    f.observe(new Uint8Array([0x41]));
    expect(f.setPredictedCursor).toHaveBeenLastCalledWith(0, 1, true);
  });

  it("drives one predicted cursor per pane, so typing in one pane leaves the other's alone", () => {
    const left = fakeCtx();
    const right = fakeCtx();
    predictiveEcho().setup(left.ctx);
    predictiveEcho().setup(right.ctx);
    arm(left, 0, 0);
    arm(right, 4, 4);
    right.setPredictedCursor.mockClear();
    left.observe(new Uint8Array([0x41, 0x42]));
    expect(left.setPredictedCursor).toHaveBeenLastCalledWith(0, 2, true);
    expect(right.setPredictedCursor).not.toHaveBeenCalled();
    right.emit("render:cursor", undefined);
    expect(right.setPredictedCursor).toHaveBeenLastCalledWith(4, 4, true);
  });

  it("onDetach resets prediction so a switched-away session's ghost cursor is dropped", () => {
    const f = fakeCtx();
    const inst = predictiveEcho().setup(f.ctx) as FeatureInstance;
    arm(f, 0, 5);
    f.setPredictedCursor.mockClear();
    inst.onDetach?.();
    expect(f.setPredictedCursor).toHaveBeenLastCalledWith(0, 0, false);
    // A DEL at what is now (0,0) with prediction inactive passes through: the
    // brake reads the reset predictor.
    expect(Array.from(f.transform(new Uint8Array([DEL])))).toEqual([DEL]);
  });

  it("resets on connection:state 'restarted' but not on a benign state", () => {
    const f = fakeCtx();
    predictiveEcho().setup(f.ctx);
    arm(f, 0, 5);
    f.setPredictedCursor.mockClear();
    f.emit("connection:state", "offline");
    expect(f.setPredictedCursor).not.toHaveBeenCalled();
    f.emit("connection:state", "restarted");
    expect(f.setPredictedCursor).toHaveBeenLastCalledWith(0, 0, false);
  });

  it("teardown hides the overlay and the deferred release silences the predictor", () => {
    const f = fakeCtx();
    const inst = predictiveEcho().setup(f.ctx) as FeatureInstance;
    arm(f, 0, 5);
    f.setPredictedCursor.mockClear();
    inst.teardown();
    expect(f.setPredictedCursor).toHaveBeenLastCalledWith(0, 0, false);
    // The cleanup scope the kernel drains after teardown holds the predictor's
    // dispose; once it has run, a late frame reaches no subscriber.
    expect(f.deferred).toHaveLength(1);
    for (const release of f.deferred) {
      release();
    }
    f.setPredictedCursor.mockClear();
    arm(f, 2, 2);
    expect(f.setPredictedCursor).not.toHaveBeenCalled();
  });
});

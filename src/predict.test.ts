// The predicted cursor under each byte it models and each it refuses. A wrong
// prediction is worse than a missing one, so every byte it cannot model without
// a copy of the server's cursor rules suspends it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPredictor, type Predictor } from "./predict.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const BS = 0x08;
const DEL = 0x7f;

let cols: number;
let predict: Predictor;

beforeEach(() => {
  cols = 80;
  predict = createPredictor(() => cols);
  predict.onScreenFrame(0, 0);
});

describe("predict: printable ASCII advances one cell", () => {
  it("advances the column once per character", () => {
    predict.applyInput(enc("abc"));
    expect(predict.get()).toEqual({ row: 0, col: 3, active: true });
  });

  it("advances the space and the tilde, the ends of the printable range", () => {
    predict.applyInput(enc(" ~"));
    expect(predict.get()).toEqual({ row: 0, col: 2, active: true });
  });
});

describe("predict: anything whose width the server decides suspends", () => {
  it("an accented letter suspends after the ASCII before it", () => {
    predict.applyInput(enc("aé"));
    expect(predict.get()).toEqual({ row: 0, col: 1, active: false });
  });

  it("a wide character suspends", () => {
    predict.applyInput(enc("中"));
    expect(predict.get()).toEqual({ row: 0, col: 0, active: false });
  });

  it("an emoji suspends", () => {
    predict.applyInput(enc("🙂"));
    expect(predict.get()).toEqual({ row: 0, col: 0, active: false });
  });
});

describe("predict: Backspace and DEL", () => {
  it("move back one column", () => {
    predict.onScreenFrame(0, 5);
    predict.applyInput(new Uint8Array([DEL]));
    expect(predict.get()).toEqual({ row: 0, col: 4, active: true });
    predict.applyInput(new Uint8Array([BS]));
    expect(predict.get()).toEqual({ row: 0, col: 3, active: true });
  });

  it("suspend at the first column, where a line editor may join the previous row", () => {
    predict.onScreenFrame(2, 0);
    predict.applyInput(new Uint8Array([DEL]));
    expect(predict.get()).toEqual({ row: 2, col: 0, active: false });
  });
});

describe("predict: control bytes suspend", () => {
  it.each([
    ["CR", 0x0d],
    ["LF", 0x0a],
    ["TAB", 0x09],
    ["ESC", 0x1b],
    ["NUL", 0x00],
  ])("%s suspends without moving the cursor", (_name, byte) => {
    predict.onScreenFrame(2, 30);
    predict.applyInput(new Uint8Array([byte]));
    expect(predict.get()).toEqual({ row: 2, col: 30, active: false });
  });
});

describe("predict: the right edge is the server's", () => {
  it("parks at the last column of a 40-column screen and suspends on the next character", () => {
    cols = 40;
    predict.onScreenFrame(0, 38);
    predict.applyInput(enc("a"));
    expect(predict.get()).toEqual({ row: 0, col: 39, active: true });
    predict.applyInput(enc("b"));
    expect(predict.get()).toEqual({ row: 0, col: 39, active: false });
  });

  it("suspends on a Backspace at the last column, where a wrap may be pending", () => {
    cols = 40;
    predict.onScreenFrame(0, 39);
    predict.applyInput(new Uint8Array([DEL]));
    expect(predict.get()).toEqual({ row: 0, col: 39, active: false });
  });

  it("reads the width at each input, so a resize between frames is honoured", () => {
    predict.onScreenFrame(0, 38);
    cols = 39;
    predict.applyInput(enc("a"));
    expect(predict.get()).toEqual({ row: 0, col: 38, active: false });
  });

  it("predicts nothing while the width is unknown", () => {
    cols = 0;
    predict.applyInput(enc("a"));
    expect(predict.get()).toEqual({ row: 0, col: 0, active: false });
  });
});

describe("predict: a suspension lasts until the next frame", () => {
  it("ignores input after a suspension and re-arms at the frame's cursor", () => {
    predict.applyInput(new Uint8Array([0x1b]));
    predict.applyInput(enc("aaa"));
    expect(predict.get()).toEqual({ row: 0, col: 0, active: false });
    predict.onScreenFrame(0, 5);
    predict.applyInput(enc("a"));
    expect(predict.get()).toEqual({ row: 0, col: 6, active: true });
  });
});

describe("predict: reset()", () => {
  it("clears all state back to the inactive origin", () => {
    predict.onScreenFrame(5, 10);
    predict.applyInput(enc("abc"));
    predict.reset();
    expect(predict.get()).toEqual({ row: 0, col: 0, active: false });
  });
});

describe("predict: frozen when the server cursor is hidden", () => {
  it("onScreenFrame with cursorHidden=true deactivates prediction", () => {
    predict.onScreenFrame(3, 7, true);
    expect(predict.get()).toEqual({ row: 3, col: 7, active: false });
  });
  it("applyInput is a no-op while frozen", () => {
    predict.onScreenFrame(3, 7, true);
    predict.applyInput(enc("abc"));
    expect(predict.get()).toEqual({ row: 3, col: 7, active: false });
  });
  it("a later non-hidden frame re-arms prediction", () => {
    predict.onScreenFrame(3, 7, true);
    predict.applyInput(enc("abc"));
    predict.onScreenFrame(3, 7, false);
    predict.applyInput(enc("ab"));
    expect(predict.get()).toEqual({ row: 3, col: 9, active: true });
  });
});

describe("predict: subscribe notifies on every state change", () => {
  it("fires onChange for applyInput, onScreenFrame, and reset", () => {
    const onChange = vi.fn();
    predict.subscribe(onChange);
    predict.onScreenFrame(0, 0);
    const afterFrame = onChange.mock.calls.length;
    predict.applyInput(enc("a"));
    const afterInput = onChange.mock.calls.length;
    predict.reset();
    const afterReset = onChange.mock.calls.length;
    expect(afterFrame).toBeGreaterThan(0);
    expect(afterInput).toBeGreaterThan(afterFrame);
    expect(afterReset).toBeGreaterThan(afterInput);
  });

  it("notifies when a byte suspends prediction, so the overlay hides", () => {
    const onChange = vi.fn();
    predict.subscribe(onChange);
    predict.applyInput(new Uint8Array([0x1b]));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("predict: dispose()", () => {
  it("drops the subscriber and returns the cursor to the inactive origin", () => {
    const onChange = vi.fn();
    predict.subscribe(onChange);
    predict.onScreenFrame(5, 10);
    predict.applyInput(enc("abc"));
    predict.dispose();
    expect(predict.get()).toEqual({ row: 0, col: 0, active: false });
    onChange.mockClear();
    predict.onScreenFrame(1, 1);
    predict.applyInput(enc("x"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("two predictors do not share a cursor", () => {
    const other = createPredictor(() => 80);
    other.onScreenFrame(4, 4);
    predict.applyInput(enc("abc"));
    expect(predict.get()).toEqual({ row: 0, col: 3, active: true });
    expect(other.get()).toEqual({ row: 4, col: 4, active: true });
  });
});

describe("predict: prediction is off until the first server frame", () => {
  // Guessing from (0,0) would put a ghost cursor on a screen that has not been
  // painted yet, over a session whose cursor is wherever the shell left it.

  it("reports an inactive cursor at the origin before any frame arrives", () => {
    const p = createPredictor(() => 80);
    expect(p.get()).toEqual({ row: 0, col: 0, active: false });
  });

  it("ignores typed input until a frame arms it, and notifies no subscriber", () => {
    const p = createPredictor(() => 80);
    const onChange = vi.fn();
    p.subscribe(onChange);
    p.applyInput(enc("hello"));
    expect(p.get()).toEqual({ row: 0, col: 0, active: false });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("starts predicting from the position the first frame reports", () => {
    const p = createPredictor(() => 80);
    p.onScreenFrame(3, 7);
    p.applyInput(enc("ab"));
    expect(p.get()).toEqual({ row: 3, col: 9, active: true });
  });
});

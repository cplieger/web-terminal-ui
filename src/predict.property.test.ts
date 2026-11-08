import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createPredictor } from "./predict.js";

describe("predict: property - the predicted cursor never leaves the server's row or width", () => {
  it("keeps the frame's row and a column inside the screen for any input bytes", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 200 })
          .chain((cols) =>
            fc.tuple(
              fc.constant(cols),
              fc.integer({ min: 0, max: cols - 1 }),
              fc.integer({ min: 0, max: 60 }),
            ),
          ),
        fc.uint8Array({ maxLength: 512 }),
        ([cols, col, row], bytes) => {
          const predict = createPredictor(() => cols);
          predict.onScreenFrame(row, col);
          predict.applyInput(bytes);
          const p = predict.get();
          expect(p.row).toBe(row);
          expect(p.col).toBeGreaterThanOrEqual(0);
          expect(p.col).toBeLessThanOrEqual(cols - 1);
        },
      ),
    );
  });
});

describe("predict: property - printable advance and backspace are inverse within a row", () => {
  it("n printable ASCII cells advance the column by exactly n; n backspaces return to the origin", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 200 }),
        fc.array(fc.integer({ min: 0x20, max: 0x7e }), { maxLength: 50 }),
        (cols, codes) => {
          const predict = createPredictor(() => cols);
          predict.onScreenFrame(0, 1);
          predict.applyInput(new Uint8Array(codes));
          // maxLength 50 < min cols 60, so the last column is never reached.
          expect(predict.get()).toEqual({ row: 0, col: 1 + codes.length, active: true });
          predict.applyInput(new Uint8Array(codes.length).fill(0x08));
          expect(predict.get()).toEqual({ row: 0, col: 1, active: true });
        },
      ),
    );
  });
});

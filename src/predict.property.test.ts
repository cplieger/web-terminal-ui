import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as predict from "./predict.js";

describe("predict: property - the predicted cursor never escapes the screen", () => {
  it("keeps row/col within the current dimensions for any input bytes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 200 }),
        fc.uint8Array({ maxLength: 512 }),
        (cols, rows, bytes) => {
          predict.setDimensions(cols, rows);
          predict.onScreenFrame(0, 0);
          predict.applyInput(bytes);
          const p = predict.get();
          expect(p.row).toBeGreaterThanOrEqual(0);
          expect(p.row).toBeLessThanOrEqual(rows - 1);
          expect(p.col).toBeGreaterThanOrEqual(0);
          expect(p.col).toBeLessThanOrEqual(cols - 1);
        },
      ),
    );
  });
});

describe("predict: property - printable advance and backspace are inverse within a row", () => {
  it("n printable ASCII cells advance the column by exactly n; n backspaces return to the origin (no wrap)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 200 }),
        fc.array(fc.integer({ min: 0x20, max: 0x7e }), { maxLength: 50 }),
        (cols, codes) => {
          predict.setDimensions(cols, 24);
          predict.onScreenFrame(0, 0);
          predict.applyInput(new Uint8Array(codes));
          // maxLength 50 < min cols 60, so no line wrap occurs: col equals the count.
          expect(predict.get()).toEqual({ row: 0, col: codes.length, active: true });
          predict.applyInput(new Uint8Array(codes.length).fill(0x08));
          expect(predict.get()).toEqual({ row: 0, col: 0, active: true });
        },
      ),
    );
  });
});

// predictiveEcho feature: Mosh-style local echo (design section 22.4). Wires the
// predict.ts mini-VT to the kernel input funnel: it advances a predicted cursor
// on accepted input (an input observer) and owns the col-0 backspace brake (an
// input transform that drops a lone DEL at the true origin, since the predicted
// cursor is the authoritative position for that decision). It re-pushes the
// predicted-cursor overlay on prediction changes and after each render flush.

import * as predict from "../predict.js";
import type { TerminalFeature } from "../kernel/types.js";

export function predictiveEcho(): TerminalFeature {
  return {
    name: "predictiveEcho",
    setup(ctx) {
      function push(): void {
        const p = predict.get();
        ctx.render.setPredictedCursor(p.row, p.col, p.active);
      }
      predict.subscribe(push);

      // Col-0 backspace brake: suppress a lone DEL at the true origin (row 0,
      // col 0) so held-Backspace on an empty line does not flood the server.
      // Owned here because the predicted cursor is the position it keys off.
      const offTransform = ctx.registerInputTransform((bytes) => {
        const p = predict.get();
        if (bytes.length === 1 && bytes[0] === 0x7f && p.active && p.row === 0 && p.col === 0) {
          return new Uint8Array(0);
        }
        return bytes;
      });
      const offObserver = ctx.registerInputObserver((bytes) => {
        predict.applyInput(bytes);
      });

      const offCursor = ctx.on("render:cursor", () => {
        push();
      });
      const offScreen = ctx.on("wire:screen", (msg) => {
        const sz = ctx.session.size();
        predict.setDimensions(sz.cols, sz.rows);
        predict.onScreenFrame(msg.cursor[0], msg.cursor[1], msg.cursorHidden);
      });
      const offState = ctx.on("connection:state", (s) => {
        if (s === "restarted") {
          predict.reset();
        }
      });

      return {
        teardown() {
          offTransform();
          offObserver();
          offCursor();
          offScreen();
          offState();
          // Hide the overlay and drop stale prediction state.
          predict.reset();
          ctx.render.setPredictedCursor(0, 0, false);
        },
      };
    },
  };
}

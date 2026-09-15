/**
 * predictiveEcho feature: Mosh-style local echo. Wires the
 * predict.ts mini-VT to the kernel input funnel: it advances a predicted cursor
 * on accepted input (an input observer) and owns the col-0 backspace brake (an
 * input transform that drops a lone DEL at the true origin, since the predicted
 * cursor is the authoritative position for that decision). It re-pushes the
 * predicted-cursor overlay on prediction changes and after each render flush.
 *
 * @module
 */

import * as predict from "../predict.js";
import type { TerminalFeature } from "../kernel/types.js";

/** Build the predictiveEcho feature. Exposes no API — its output is the engine
 *  renderer's predicted-cursor overlay.
 *
 *  The prediction state is MODULE-scoped (`../predict.js`), not per instance, so two
 *  terminals in one page that both include this feature would drive one predicted
 *  cursor between them. That is within the kernel's existing "call createTerminal
 *  exactly once" contract, but it is the reason this feature cannot be made
 *  per-instance by composing it twice.
 *
 *  Predictions are advisory: `predict` suspends itself on any byte it cannot
 *  model, because a wrong prediction is worse than a missing one. The feature
 *  resets it on a server restart and on a tab switch (`onDetach`), so the outgoing
 *  session's ghost cursor never paints over the incoming session's screen; the
 *  next server frame re-arms it. Teardown drops every listener, hides the overlay,
 *  and clears the prediction. */
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
        // A tab switch (kernel notifySwitch -> onDetach) must drop the predicted
        // cursor, so the outgoing session's ghost cursor does not paint on the
        // incoming session's freshly-bound screen until its first server frame
        // re-arms prediction. Mirrors composition.cancelComposition on the same
        // detach: both local-echo paths reset on switch. predict.reset() hides the
        // overlay (its onChange -> push -> setPredictedCursor(0,0,false)); the next
        // wire:screen re-arms via onScreenFrame.
        onDetach() {
          predict.reset();
        },
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

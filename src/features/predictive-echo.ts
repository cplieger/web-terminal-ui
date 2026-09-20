import { createPredictor } from "../predict.js";
import type { TerminalFeature } from "../kernel/types.js";

/** Build the predictiveEcho feature: Mosh-style local echo through one predictor
 *  per pane, drawn as the renderer's predicted-cursor overlay. The predictor
 *  suspends itself on any byte it cannot model, because a wrong prediction is
 *  worse than a missing one; a server restart and a tab switch reset it so the
 *  outgoing session's ghost cursor never paints over the incoming screen. */
export function predictiveEcho(): TerminalFeature {
  return {
    name: "predictiveEcho",
    setup(ctx) {
      const predict = createPredictor();
      ctx.defer(() => {
        predict.dispose();
      });
      function push(): void {
        const p = predict.get();
        ctx.render.setPredictedCursor(p.row, p.col, p.active);
      }
      predict.subscribe(push);

      ctx.registerInputTransform((bytes) => {
        const p = predict.get();
        if (bytes.length === 1 && bytes[0] === 0x7f && p.active && p.row === 0 && p.col === 0) {
          return new Uint8Array(0);
        }
        return bytes;
      });
      ctx.registerInputObserver((bytes) => {
        predict.applyInput(bytes);
      });
      ctx.on("render:cursor", () => {
        push();
      });
      ctx.on("wire:screen", (msg) => {
        const sz = ctx.session.size();
        predict.setDimensions(sz.cols, sz.rows);
        predict.onScreenFrame(msg.cursor[0], msg.cursor[1], msg.cursorHidden);
      });
      ctx.on("connection:state", (s) => {
        if (s === "restarted") {
          predict.reset();
        }
      });

      return {
        onDetach() {
          predict.reset();
        },
        teardown() {
          predict.reset();
          ctx.render.setPredictedCursor(0, 0, false);
        },
      };
    },
  };
}

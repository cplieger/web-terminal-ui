import { createPredictor } from "../predict.js";
import type { TerminalFeature } from "../kernel/types.js";

/** Build the predictiveEcho feature: local echo through one predictor per pane,
 *  drawn as the renderer's predicted-cursor overlay against the session's screen
 *  width. It never changes what is sent. A server restart and a tab switch reset
 *  it so the outgoing session's ghost cursor never paints over the incoming screen. */
export function predictiveEcho(): TerminalFeature {
  return {
    name: "predictiveEcho",
    setup(ctx) {
      const predict = createPredictor(() => ctx.session.size().cols);
      ctx.defer(() => {
        predict.dispose();
      });
      function push(): void {
        const p = predict.get();
        ctx.render.setPredictedCursor(p.row, p.col, p.active);
      }
      predict.subscribe(push);

      ctx.registerInputObserver((bytes) => {
        predict.applyInput(bytes);
      });
      ctx.on("render:cursor", () => {
        push();
      });
      ctx.on("wire:screen", (msg) => {
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
          ctx.render.setPredictedCursor(0, 0, false);
        },
      };
    },
  };
}

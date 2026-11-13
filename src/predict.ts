// Predictive local echo: a predicted cursor that advances as the user types,
// before the server's next screen frame confirms it. It predicts only what needs
// no copy of the server's cursor rules (`vt.Screen.put` owns those): printable
// ASCII advances one cell and Backspace or DEL moves back one. Every other byte,
// Backspace or DEL at the first column and any byte at the last column suspend
// prediction until the next frame resets it to the server's cursor.

/** One pane's predicted cursor. */
export interface Predictor {
  /** Subscribe to predicted-cursor changes; one subscriber (the overlay). */
  subscribe(cb: () => void): void;
  /** Drop every prediction and hide the overlay (a server restart, a switch). */
  reset(): void;
  /** Reset to the server's reported cursor and re-arm, unless the server cursor
   *  is hidden (a selection prompt), which freezes prediction. */
  onScreenFrame(serverRow: number, serverCol: number, cursorHidden?: boolean): void;
  /** Apply locally-typed bytes; suspends on the first byte it cannot model. */
  applyInput(bytes: Uint8Array): void;
  /** `active` is false while prediction is suspended. */
  get(): { row: number; col: number; active: boolean };
  /** Clear the subscriber and the state. */
  dispose(): void;
}

/** `columns` answers the server screen's width, read at each input. */
export function createPredictor(columns: () => number): Predictor {
  let predRow = 0;
  let predCol = 0;
  let predActive = false;
  let onChange: (() => void) | null = null;

  function reset(): void {
    predRow = 0;
    predCol = 0;
    predActive = false;
    onChange?.();
  }

  // The server's put wraps at the last column only on the NEXT printable, and a
  // frame does not say whether that wrap is pending, so no byte there is modelled.
  function step(b: number, lastCol: number): boolean {
    if (predCol >= lastCol) {
      return false;
    }
    if (b >= 0x20 && b < 0x7f) {
      predCol++;
      return true;
    }
    if ((b === 0x08 || b === 0x7f) && predCol > 0) {
      predCol--;
      return true;
    }
    return false;
  }

  return {
    subscribe(cb) {
      onChange = cb;
    },
    reset,
    onScreenFrame(serverRow, serverCol, cursorHidden) {
      predRow = serverRow;
      predCol = serverCol;
      predActive = !(cursorHidden ?? false);
      onChange?.();
    },
    applyInput(bytes) {
      if (!predActive) {
        return;
      }
      const lastCol = columns() - 1;
      for (const b of bytes) {
        if (!step(b, lastCol)) {
          predActive = false;
          break;
        }
      }
      onChange?.();
    },
    get() {
      return { row: predRow, col: predCol, active: predActive };
    },
    dispose() {
      onChange = null;
      reset();
    },
  };
}

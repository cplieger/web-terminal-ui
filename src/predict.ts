// Predictive local echo: a Mosh-style mini-VT that advances a predicted cursor
// as the user types, before the server's next screen frame confirms it. Purely a
// local-render optimisation, deliberately conservative because a wrong
// prediction looks like a broken terminal: printable codepoints advance one
// cell, BS/DEL back one, CR to col 0, LF down one row; anything else (ESC, TAB,
// other C0) suspends prediction until the next server frame, which resets the
// predicted cursor to the server's position and re-arms it.

/** One pane's predicted cursor. */
export interface Predictor {
  /** Subscribe to predicted-cursor changes; one subscriber (the overlay). */
  subscribe(cb: () => void): void;
  /** The screen size the wrap arithmetic uses; the predicted position is
   *  clamped into it. */
  setDimensions(cols: number, rows: number): void;
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

export function createPredictor(): Predictor {
  let predRow = 0;
  let predCol = 0;
  let predActive = false;
  let predPendingWrap = false;
  let predFrozen = false;
  let cols = 80;
  let rows = 30;
  let onChange: (() => void) | null = null;

  function reset(): void {
    predRow = 0;
    predCol = 0;
    predActive = false;
    predPendingWrap = false;
    predFrozen = false;
    onChange?.();
  }

  return {
    subscribe(cb) {
      onChange = cb;
    },
    setDimensions(c, r) {
      if (c > 0) {
        cols = c;
      }
      if (r > 0) {
        rows = r;
      }
      const prevCol = predCol;
      const prevRow = predRow;
      if (predCol >= cols) {
        predCol = cols - 1;
      }
      if (predRow >= rows) {
        predRow = rows - 1;
      }
      if (predCol !== prevCol || predRow !== prevRow) {
        onChange?.();
      }
    },
    reset,
    onScreenFrame(serverRow, serverCol, cursorHidden) {
      predRow = serverRow;
      predCol = serverCol;
      predPendingWrap = false;
      predFrozen = cursorHidden ?? false;
      predActive = !predFrozen;
      onChange?.();
    },
    applyInput(bytes) {
      if (!predActive || predFrozen) {
        return;
      }
      let i = 0;
      while (i < bytes.length) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index checked by loop condition
        const b = bytes[i]!;
        if (b === 0x1b) {
          predActive = false;
          onChange?.();
          return;
        }
        if (b === 0x08 || b === 0x7f) {
          predPendingWrap = false;
          if (predCol > 0) {
            predCol--;
          } else if (predRow > 0) {
            // kiro-cli's prompt wraps a Backspace at col 0 to the previous row.
            predRow--;
            predCol = cols - 1;
          }
          i++;
          continue;
        }
        if (b === 0x0d) {
          predPendingWrap = false;
          predCol = 0;
          i++;
          continue;
        }
        if (b === 0x0a) {
          predPendingWrap = false;
          predRow = Math.min(predRow + 1, rows - 1);
          i++;
          continue;
        }
        if (b < 0x20) {
          predActive = false;
          onChange?.();
          return;
        }
        // Mirror the server VT's pendingWrap: at the last column stay put and
        // wrap before the NEXT character.
        let len = 1;
        if (b >= 0xc0 && b < 0xe0) {
          len = 2;
        } else if (b >= 0xe0 && b < 0xf0) {
          len = 3;
        } else if (b >= 0xf0) {
          len = 4;
        }
        i += len;
        if (predPendingWrap) {
          predCol = 0;
          predRow = Math.min(predRow + 1, rows - 1);
          predPendingWrap = false;
        }
        if (predCol >= cols - 1) {
          predCol = cols - 1;
          predPendingWrap = true;
        } else {
          predCol++;
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

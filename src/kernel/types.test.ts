import { describe, expect, expectTypeOf, it } from "vitest";
import { POWER_ON_MODES, createModeState, type ModeState } from "@cplieger/web-terminal-engine";
import type { ModeReaders } from "./types.js";

describe("ModeReaders", () => {
  it("names exactly the engine's nine mode readers", () => {
    expectTypeOf<keyof ModeReaders>().toEqualTypeOf<
      | "isBracketedPaste"
      | "isApplicationCursor"
      | "getMouseMode"
      | "isMouseSGR"
      | "isMousePixels"
      | "isFocusReporting"
      | "isApplicationKeypad"
      | "isReverseVideo"
      | "getKeyboardFlags"
    >();
    expectTypeOf<ModeState>().toExtend<ModeReaders>();
    // A feature reads the engine's state through the interface, so an engine
    // mode state is one, at runtime as well as in the type.
    const readers: ModeReaders = createModeState({ ...POWER_ON_MODES, mouseMode: 1002 });
    expect(readers.getMouseMode()).toBe(1002);
    expect(readers.isBracketedPaste()).toBe(true);
  });
});

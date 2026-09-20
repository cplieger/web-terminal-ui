import { describe, it, expect } from "vitest";
import { clampRatio, MIN_PANE_PX, MIN_SPLIT_AREA_PX, SPLIT_GUTTER_PX } from "./layout-policy.js";

describe("the width two panes need", () => {
  it("is two minimum panes and the gutter", () => {
    expect(MIN_PANE_PX).toBe(360);
    expect(SPLIT_GUTTER_PX).toBe(10);
    expect(MIN_SPLIT_AREA_PX).toBe(730);
  });
});

describe("clampRatio", () => {
  it("passes a share through when both panes stay over the minimum", () => {
    expect(clampRatio(0.4, 1000)).toBe(0.4);
    expect(clampRatio(0.5, 1000)).toBe(0.5);
  });

  it("holds the left pane at the minimum when the share would squeeze it", () => {
    expect(clampRatio(0.3, 1000)).toBe(360 / 990);
    expect(clampRatio(0.4, 800)).toBe(360 / 790);
    expect(clampRatio(0, 1000)).toBe(360 / 990);
  });

  it("holds the right pane at the minimum when the share would squeeze it", () => {
    expect(clampRatio(0.9, 1000)).toBe(1 - 360 / 990);
    expect(clampRatio(1, 800)).toBe(1 - 360 / 790);
  });

  it("gives 0.5 at exactly the width two panes need, whatever the share", () => {
    expect(clampRatio(0.2, 730)).toBe(0.5);
    expect(clampRatio(0.8, 730)).toBe(0.5);
  });

  it("gives 0.5 under that width, where a split can only be collapsed", () => {
    expect(clampRatio(0.2, 720)).toBe(0.5);
    expect(clampRatio(0.4, 0)).toBe(0.5);
  });
});

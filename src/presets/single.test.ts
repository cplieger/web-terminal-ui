// @vitest-environment happy-dom
//
// Composition contract for presetSingle: the context menu is handed the SAME
// clipboard feature value the array includes, not a second one and not none.
// The menu reads it through ctx.use, which resolves by feature identity, so a
// menu holding a clipboard that is not in the composition silently offers no
// Copy/Paste — a defect no assertion on feature NAMES can see. contextMenu is
// mocked at the module boundary so the argument is readable; every other
// feature in the composition is the real one.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TerminalFeature } from "../kernel/types.js";

// clearMocks/mockReset strip a vi.fn implementation before each test, so the
// recording lives in a hoisted record that a plain-function factory closes over.
const rec = vi.hoisted(() => ({ menuOpts: [] as unknown[] }));

vi.mock("../features/context-menu.js", () => ({
  contextMenu: (opts: unknown): TerminalFeature<unknown> => {
    rec.menuOpts.push(opts);
    return { name: "contextMenu", setup: () => ({ teardown: () => undefined }) };
  },
}));

beforeEach(() => {
  rec.menuOpts.length = 0;
});

describe("presetSingle: the context menu shares the composition's clipboard", () => {
  it("hands contextMenu the very clipboard feature the array includes", async () => {
    const { presetSingle } = await import("./single.js");
    const set = presetSingle();
    const clip = set.find((f) => f.name === "clipboard");
    expect(clip).toBeDefined();
    expect((rec.menuOpts[0] as { clipboard?: unknown }).clipboard).toBe(clip);
  });
});

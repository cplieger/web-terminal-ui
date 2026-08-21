// @vitest-environment happy-dom
//
// presetAgentTabbed's whole body is the argument it passes to buildTabbed, so
// that argument is what has to be pinned. presets.test.ts compares FEATURE NAMES
// between the two tabbed presets and they are identical by design, which is
// exactly why a name comparison cannot see this preset's only decision; and
// tabbed.test.ts drives buildTabbed directly, which does not prove that the
// exported preset reaches it with the agent flag set.
//
// The tabs feature is mocked at the module boundary (the pattern in
// tabbed.test.ts) so the composed options are readable.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TerminalFeature } from "../kernel/types.js";

// clearMocks/mockReset strip a vi.fn implementation before each test, so the
// recording lives in a hoisted record that a plain-function factory closes over.
const rec = vi.hoisted(() => ({ tabsOpts: [] as unknown[] }));

vi.mock("../features/tabs/index.js", () => ({
  tabs: (opts: unknown): TerminalFeature<unknown> => {
    rec.tabsOpts.push(opts);
    return { name: "tabs", setup: () => ({ teardown: () => undefined }) };
  },
}));

interface TabsOpts {
  presumeReports?: boolean;
  attentionIcons?: boolean;
}

beforeEach(() => {
  rec.tabsOpts.length = 0;
});

describe("presetAgentTabbed", () => {
  it("presumes every session reports activity, so a tab's dot is there from creation", async () => {
    // The one thing this preset exists to say. Without it an agent's tab grows
    // its idle dot seconds late, when the agent has booted far enough to first
    // report OSC 9;4 — and the server's sticky flag then merely confirms what
    // the tab already showed.
    const { presetAgentTabbed } = await import("./agent-tabbed.js");

    presetAgentTabbed();

    expect((rec.tabsOpts[0] as TabsOpts).presumeReports).toBe(true);
  });

  it("passes the consumer's own options through to the tabbed composition", async () => {
    // The agent flag is the preset's, everything else is the caller's; a preset
    // that swallowed its options would silently ignore them.
    const { presetAgentTabbed } = await import("./agent-tabbed.js");

    presetAgentTabbed({ attentionIcons: true });

    expect((rec.tabsOpts[0] as TabsOpts).attentionIcons).toBe(true);
    expect((rec.tabsOpts[0] as TabsOpts).presumeReports).toBe(true);
  });
});

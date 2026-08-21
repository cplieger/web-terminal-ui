// @vitest-environment happy-dom
//
// Composition contract for the tabbed presets: WHICH OPTIONS buildTabbed hands
// each feature it composes. presets.test.ts already proves the feature NAMES
// line up; names cannot see the difference between presetTabbed and
// presetAgentTabbed, nor between a tabs feature that was wired to the toolbar
// and one that was left unwired, and both of those are the whole job of this
// module. The two collaborators whose options carry the contract are mocked at
// the module boundary so the arguments are readable; every other feature in the
// composition is the real one.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TerminalFeature } from "../kernel/types.js";

// clearMocks/mockReset strip a vi.fn implementation before each test, so the
// recording lives in a hoisted record that a plain-function factory closes over.
const rec = vi.hoisted(() => ({
  toolbarOpts: [] as unknown[],
  tabsOpts: [] as unknown[],
}));

vi.mock("../features/mobile-toolbar.js", () => ({
  mobileToolbar: (opts: unknown): TerminalFeature<unknown> => {
    rec.toolbarOpts.push(opts);
    return { name: "mobileToolbar", setup: () => ({ teardown: () => undefined }) };
  },
}));

vi.mock("../features/tabs/index.js", () => ({
  tabs: (opts: unknown): TerminalFeature<unknown> => {
    rec.tabsOpts.push(opts);
    return { name: "tabs", setup: () => ({ teardown: () => undefined }) };
  },
}));

interface TabsOpts {
  keyboardToggle?: unknown;
  activityMonitor?: unknown;
  presumeReports?: boolean;
  attentionIcons?: boolean;
}

beforeEach(() => {
  rec.toolbarOpts.length = 0;
  rec.tabsOpts.length = 0;
});

const featureNamed = (
  set: TerminalFeature<unknown>[],
  name: string,
): TerminalFeature<unknown> | undefined => set.find((f) => f.name === name);

describe("buildTabbed: the mobile toolbar is externally driven", () => {
  it("hands the toolbar externalToggle, so it hides its own toggle and opens above the tab bar", async () => {
    const { presetTabbed } = await import("./tabbed.js");
    presetTabbed();
    expect(rec.toolbarOpts).toEqual([{ externalToggle: true }]);
  });
});

describe("buildTabbed: tabs is wired to the toolbar and the monitor it composed", () => {
  it("passes the SAME toolbar and monitor instances that the feature array holds", async () => {
    const { presetTabbed } = await import("./tabbed.js");
    const set = presetTabbed();
    const opts = rec.tabsOpts[0] as TabsOpts;
    expect(opts.keyboardToggle).toBe(featureNamed(set, "mobileToolbar"));
    expect(opts.activityMonitor).toBe(featureNamed(set, "activityMonitor"));
  });
});

describe("buildTabbed: presumed activity reporting follows the shell", () => {
  it("presetTabbed presumes nothing, so a plain shell's tab shows no dot until it reports", async () => {
    const { presetTabbed } = await import("./tabbed.js");
    presetTabbed();
    expect((rec.tabsOpts[0] as TabsOpts).presumeReports).toBe(false);
  });

  it("the agent shell presumes reporting", async () => {
    const { buildTabbed } = await import("./tabbed.js");
    buildTabbed(true);
    expect((rec.tabsOpts[0] as TabsOpts).presumeReports).toBe(true);
  });
});

describe("buildTabbed: attentionIcons is opt-in and strictly boolean", () => {
  it("is off when the consumer says nothing", async () => {
    const { presetTabbed } = await import("./tabbed.js");
    presetTabbed();
    expect((rec.tabsOpts[0] as TabsOpts).attentionIcons).toBe(false);
  });

  it("is on when the consumer asks for it", async () => {
    const { presetTabbed } = await import("./tabbed.js");
    presetTabbed({ attentionIcons: true });
    expect((rec.tabsOpts[0] as TabsOpts).attentionIcons).toBe(true);
  });
});

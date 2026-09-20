// Composition tests (design section 22.10): the presetTouch bundle assembles and
// mounts, each feature contributes its chrome into the right region, the
// clipboard shortcut routes through the sanitizing funnel, and destroy tears the
// whole set down.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { TerminalHandle } from "./kernel/types.js";
import { presetTouch } from "./presets.js";
import { mountTerminal } from "./test-helpers/mount.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("./test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const { sendBinary } = fake.connection;

const dec = new TextDecoder();
const sentText = (): string => sendBinary.mock.calls.map((c) => dec.decode(c[0])).join("");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
});

async function mountTouch(): Promise<{ root: HTMLElement; term: TerminalHandle }> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const term = await mountTerminal(root, { features: () => presetTouch() });
  return { root, term };
}

describe("presetTouch composition", () => {
  it("assembles every feature's chrome into its region", async () => {
    const { root } = await mountTouch();
    await tick();
    expect(root.querySelector(".key-toolbar")).not.toBeNull(); // mobileToolbar
    expect(root.querySelector(".wt-scroll-bottom")).not.toBeNull(); // scrollToBottom
    expect(root.querySelector(".wt-conn-banner")).not.toBeNull(); // connectionBanner
    expect(root.querySelector(".wt-ctx-menu")).not.toBeNull(); // contextMenu
  });

  it("stacks the key toolbar and scroll button in the same thumb-zone region", async () => {
    const { root } = await mountTouch();
    await tick();
    const region = root.querySelector<HTMLElement>(".wt-region-bottom-inset-end");
    expect(region).not.toBeNull();
    // "keys" slot sorts before "scroll" per the region's declared order.
    expect(region?.querySelector(".key-toolbar")).not.toBeNull();
    expect(region?.querySelector(".wt-scroll-bottom")).not.toBeNull();
  });

  it("routes Ctrl+Shift+V clipboard paste through the bracketed funnel", async () => {
    // navigator.clipboard is an accessor on Navigator.prototype, so the cleanup
    // has to restore the descriptor that was there rather than delete the shadow:
    // a delete re-exposes the platform's real clipboard, which is a different
    // premise for whatever test runs next.
    const saved = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.resolve("echo hi\nrm x") },
    });
    try {
      const { root } = await mountTouch();
      await tick();
      const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
      ta.dispatchEvent(
        new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, code: "KeyV" }),
      );
      await Promise.resolve();
      await Promise.resolve();
      const sent = sentText();
      expect(sent.startsWith("\x1b[200~")).toBe(true);
      expect(sent).toContain("echo hi\rrm x");
      expect(sent.endsWith("\x1b[201~")).toBe(true);
    } finally {
      if (saved) {
        Object.defineProperty(navigator, "clipboard", saved);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("destroy tears down all feature chrome", async () => {
    const { root, term } = await mountTouch();
    await tick();
    expect(root.querySelector(".key-toolbar")).not.toBeNull();
    term.destroy();
    expect(root.querySelector(".key-toolbar")).toBeNull();
    expect(root.querySelector(".wt-conn-banner")).toBeNull();
    expect(root.childElementCount).toBe(0);
  });
});

describe("presets: composition contracts", () => {
  it("presetTabbed and presetAgentTabbed share the same feature set (they differ only in presumed activity reporting: presetAgentTabbed sets presumeReports)", async () => {
    const { presetTabbed, presetAgentTabbed } = await import("./presets.js");
    expect(presetTabbed().map((f) => f.name)).toEqual(presetAgentTabbed().map((f) => f.name));
  });

  it("both tabbed presets include the activity monitor (the per-tab dot data source)", async () => {
    const { presetTabbed, presetAgentTabbed } = await import("./presets.js");
    expect(presetTabbed().map((f) => f.name)).toContain("activityMonitor");
    expect(presetAgentTabbed().map((f) => f.name)).toContain("activityMonitor");
  });

  it("presetTouch is presetSingle plus the mobile toolbar, in order", async () => {
    const { presetSingle, presetTouch } = await import("./presets.js");
    const single = presetSingle().map((f) => f.name);
    const touch = presetTouch().map((f) => f.name);
    expect(touch.slice(0, single.length)).toEqual(single);
    expect(touch).toContain("mobileToolbar");
  });

  it("presetTabbed composes tabs, the mobile toolbar, the activity monitor, and animations", async () => {
    const { presetTabbed } = await import("./presets.js");
    const names = presetTabbed().map((f) => f.name);
    expect(names).toContain("tabs");
    expect(names).toContain("mobileToolbar");
    expect(names).toContain("activityMonitor");
    expect(names).toContain("animations");
  });
});

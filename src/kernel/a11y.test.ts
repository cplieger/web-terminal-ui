// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createAnnouncer, createTablist } from "./a11y.js";

describe("a11y: announcer", () => {
  it("creates one polite and one assertive aria-atomic live region", () => {
    const root = document.createElement("div");
    createAnnouncer(root);
    const polite = root.querySelector<HTMLElement>('[aria-live="polite"]');
    const assertive = root.querySelector<HTMLElement>('[aria-live="assertive"]');
    expect(polite).not.toBeNull();
    expect(assertive).not.toBeNull();
    expect(polite?.getAttribute("aria-atomic")).toBe("true");
    expect(assertive?.getAttribute("aria-atomic")).toBe("true");
    expect(root.children.length).toBe(2);
  });

  it("clears the region then sets the message after the ~100ms delay (repeat re-announces)", () => {
    vi.useFakeTimers();
    try {
      const root = document.createElement("div");
      const ann = createAnnouncer(root);
      const polite = root.querySelector<HTMLElement>('[aria-live="polite"]');
      ann.announce("ready");
      // Cleared synchronously so a screen reader re-announces an unchanged
      // message; the re-set waits ~100ms (a sub-frame gap is too fast for
      // some assistive tech to register two distinct mutations).
      expect(polite?.textContent).toBe("");
      vi.advanceTimersByTime(99);
      expect(polite?.textContent).toBe("");
      vi.advanceTimersByTime(1);
      expect(polite?.textContent).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rapid follow-up announcement replaces the pending one (no interleave)", () => {
    vi.useFakeTimers();
    try {
      const root = document.createElement("div");
      const ann = createAnnouncer(root);
      const polite = root.querySelector<HTMLElement>('[aria-live="polite"]');
      ann.announce("first");
      vi.advanceTimersByTime(50);
      ann.announce("second");
      vi.advanceTimersByTime(99);
      // "first" must never land: its timer was cancelled by the follow-up.
      expect(polite?.textContent).toBe("");
      vi.advanceTimersByTime(1);
      expect(polite?.textContent).toBe("second");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes an assertive message to the assertive region only", () => {
    vi.useFakeTimers();
    try {
      const root = document.createElement("div");
      const ann = createAnnouncer(root);
      ann.announce("stop", "assertive");
      vi.advanceTimersByTime(100);
      expect(root.querySelector<HTMLElement>('[aria-live="assertive"]')?.textContent).toBe("stop");
      expect(root.querySelector<HTMLElement>('[aria-live="polite"]')?.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy cancels a pending announcement", () => {
    vi.useFakeTimers();
    try {
      const root = document.createElement("div");
      const ann = createAnnouncer(root);
      ann.announce("late");
      ann.destroy();
      vi.advanceTimersByTime(200); // must not throw or write to removed nodes
      expect(root.children.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy removes both live regions from the root", () => {
    const root = document.createElement("div");
    const ann = createAnnouncer(root);
    expect(root.children.length).toBe(2);
    ann.destroy();
    expect(root.children.length).toBe(0);
  });
});

describe("a11y: tablist", () => {
  it("marks the panel a tabpanel and returns its id", () => {
    const panel = document.createElement("div");
    panel.id = "mypanel";
    const ctl = createTablist(panel);
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(ctl.panelId()).toBe("mypanel");
  });

  it("generates a fallback id for a panel/tab with none set", () => {
    const panel = document.createElement("div");
    const ctl = createTablist(panel);
    expect(panel.id).toMatch(/^wt-panel-\d+$/);
    expect(ctl.panelId()).toBe(panel.id);
    const tab = document.createElement("div");
    ctl.registerTab(tab);
    expect(tab.id).toMatch(/^wt-tab-\d+$/);
    expect(tab.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("registerTab wires role=tab, aria-controls=panel, aria-selected=false", () => {
    const panel = document.createElement("div");
    panel.id = "pnl";
    const ctl = createTablist(panel);
    const tab = document.createElement("div");
    tab.id = "tb1";
    ctl.registerTab(tab);
    expect(tab.getAttribute("role")).toBe("tab");
    expect(tab.getAttribute("aria-controls")).toBe("pnl");
    expect(tab.getAttribute("aria-selected")).toBe("false");
  });

  it("setLabel sets the tab's aria-label", () => {
    const panel = document.createElement("div");
    panel.id = "p";
    const ctl = createTablist(panel);
    const tab = document.createElement("div");
    tab.id = "t";
    const handle = ctl.registerTab(tab);
    handle.setLabel("Session 1");
    expect(tab.getAttribute("aria-label")).toBe("Session 1");
  });

  it("setSelected(true) labels the panel by the tab; deselecting a tab never relabels it", () => {
    const panel = document.createElement("div");
    panel.id = "p";
    const ctl = createTablist(panel);
    const tabA = document.createElement("div");
    tabA.id = "ta";
    const handleA = ctl.registerTab(tabA);
    const tabB = document.createElement("div");
    tabB.id = "tb";
    const handleB = ctl.registerTab(tabB);
    handleA.setSelected(true);
    expect(tabA.getAttribute("aria-selected")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).toBe("ta");
    handleB.setSelected(true);
    expect(panel.getAttribute("aria-labelledby")).toBe("tb");
    handleA.setSelected(false);
    // Deselecting ta must NOT relabel the panel back to ta (the `if (selected)` guard).
    expect(tabA.getAttribute("aria-selected")).toBe("false");
    expect(panel.getAttribute("aria-labelledby")).toBe("tb");
  });

  it("remove() clears the panel label when the removed tab currently labels it", () => {
    const panel = document.createElement("div");
    panel.id = "p";
    const ctl = createTablist(panel);
    const tab = document.createElement("div");
    tab.id = "t";
    const handle = ctl.registerTab(tab);
    handle.setSelected(true);
    expect(panel.getAttribute("aria-labelledby")).toBe("t");
    handle.remove();
    expect(panel.getAttribute("aria-labelledby")).toBeNull();
    expect(tab.hasAttribute("role")).toBe(false);
    expect(tab.hasAttribute("aria-controls")).toBe(false);
    expect(tab.hasAttribute("aria-selected")).toBe(false);
  });

  it("remove() preserves the panel label when a different tab currently labels it", () => {
    const panel = document.createElement("div");
    panel.id = "p";
    const ctl = createTablist(panel);
    const tabA = document.createElement("div");
    tabA.id = "ta";
    const handleA = ctl.registerTab(tabA);
    const tabB = document.createElement("div");
    tabB.id = "tb";
    const handleB = ctl.registerTab(tabB);
    handleA.setSelected(true);
    handleB.remove();
    // Removing the non-labelling tab must not clear the label (the === tabId guard).
    expect(panel.getAttribute("aria-labelledby")).toBe("ta");
  });
});

// Tests for the tab-title model changes and the inline rename editor: the
// eligibility filter, the first-message latch, baseLabel's pinned rung, the
// client-side name sanitizer, and the editor's own state machine (entry paths,
// commit/cancel, the empty asymmetry, the nameSeq guard, the edit-mode
// stand-downs, and teardown mid-edit).
//
// What these CANNOT prove: headless Chromium on a desktop is not an iPad, so the
// WebKit user-select hazard around caret placement and selection inside the field,
// double-tap entering edit rather than zooming, long-press still starting a reorder
// drag, soft-keyboard dismissal, and how the entry-only 300px expansion feels in a
// crowded strip are all on the manual Safari/iPad checklist in the spec instead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PINNED_NAME, baseLabel, hasPinnedName, sanitizePinnedName } from "./model.js";
import type { Tab } from "./model.js";
import type * as KernelModule from "../../kernel/kernel.js";
import type * as TabsModule from "./index.js";

// --- Pure model pieces (no DOM) ---

describe("sanitizePinnedName", () => {
  it("strips control characters, trims, and bounds the length", () => {
    expect(sanitizePinnedName("a\nb\x1bc\x7fd\te")).toBe("abcde");
    expect(sanitizePinnedName("  padded  ")).toBe("padded");
    expect(sanitizePinnedName("x".repeat(400))).toHaveLength(MAX_PINNED_NAME);
    // Bounded by CODE POINT, not code unit: a naive slice would cut the trailing
    // emoji in half and send a lone surrogate to a server that counts runes.
    const astral = sanitizePinnedName("a".repeat(MAX_PINNED_NAME - 1) + "\u{1F600}");
    expect(Array.from(astral)).toHaveLength(MAX_PINNED_NAME);
    expect(astral.endsWith("\u{1F600}")).toBe(true);
    // Control-only input sanitizes to empty, which is how the editor recognises
    // "the user cleared this".
    expect(sanitizePinnedName("\n\t\x00")).toBe("");
  });
});

function fakeTab(over: Partial<Tab>): Tab {
  return { title: "", nameSeq: 0, ...over } as Tab;
}

describe("baseLabel", () => {
  it("shows the pin above the title the server resolved", () => {
    // The pin is re-checked client-side purely so a rename paints before the
    // round trip; the server folds it into `title` as well.
    expect(baseLabel(fakeTab({ title: "resolved", pinnedTitle: "pinned" })).text).toBe("pinned");
  });

  it("shows the server's resolved title with no pin", () => {
    expect(baseLabel(fakeTab({ title: "resolved" })).text).toBe("resolved");
  });

  it("treats a whitespace-only pin as absent", () => {
    const t = fakeTab({ title: "resolved", pinnedTitle: "   " });
    expect(baseLabel(t).text).toBe("resolved");
    expect(hasPinnedName(t)).toBe(false);
    expect(hasPinnedName(fakeTab({ pinnedTitle: "x" }))).toBe(true);
  });

  it("reports the New tab fallback when the server named nothing", () => {
    expect(baseLabel(fakeTab({ title: "  ", pinnedTitle: "" }))).toEqual({
      text: "New tab",
      fallback: true,
    });
  });
});

// --- The editor and the latch, against a real kernel ---

let createTerminal: (typeof KernelModule)["createTerminal"];
let tabs: (typeof TabsModule)["tabs"];
let term: ReturnType<(typeof KernelModule)["createTerminal"]> | undefined;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let listBody: unknown[];
let pinnedFail = false;
const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const path = String(url);
  if (path.includes("/pinned-title")) {
    return Promise.resolve(
      pinnedFail ? jsonResponse({ error: "nope" }, 500) : jsonResponse(null, 204),
    );
  }
  if (method === "POST") {
    return Promise.resolve(
      jsonResponse({ id: "s-new", title: "", createdAt: "3", status: "idle" }, 201),
    );
  }
  if (method === "DELETE" || method === "PUT") {
    return Promise.resolve(jsonResponse(null, 204));
  }
  return Promise.resolve(jsonResponse(listBody, 200));
});

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockClear();
  pinnedFail = false;
  listBody = [
    { id: "s1", title: "", createdAt: "1", status: "idle" },
    { id: "s2", title: "", createdAt: "2", status: "idle" },
  ];
  vi.stubGlobal("fetch", fetchMock);
  document.body.replaceChildren();
  localStorage.clear();
  ({ createTerminal } = await import("../../kernel/kernel.js"));
  ({ tabs } = await import("./index.js"));
});

afterEach(() => {
  term?.destroy();
  term = undefined;
  vi.unstubAllGlobals();
});

async function until(pred: () => boolean, tries = 30): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mount(root: HTMLElement): Promise<void> {
  document.body.appendChild(root);
  term = createTerminal(root, { features: () => [tabs()] });
  await until(() => root.querySelectorAll(".wt-tab").length === listBody.length);
}

function labels(root: HTMLElement): (string | null)[] {
  return [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
}

function openMenu(root: HTMLElement, index: number): HTMLButtonElement[] {
  const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[index];
  chip?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  return [...root.querySelectorAll<HTMLButtonElement>(".wt-tab-menu button")];
}

function item(items: HTMLButtonElement[], label: string): HTMLButtonElement | undefined {
  return items.find((b) => b.textContent === label);
}

function field(root: HTMLElement): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(".wt-tab-rename");
}

function pressEnter(el: HTMLElement): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

// The first-message latch itself now lives in the ENGINE (terminal/inputtitle.go,
// with its own table tests, a WebSocket wiring test and a fuzz target): the server
// is the source of truth for a session's name, so the browser neither derives one
// nor decides when to stop. What remains testable here is that the UI renders what
// the server resolved, which the baseLabel cases above cover.

describe("inline rename", () => {
  it("opens from the menu, commits on Enter, and issues one PUT", async () => {
    const root = document.createElement("div");
    await mount(root);

    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    // The field starts EMPTY on an unpinned tab, with the current label only as a
    // placeholder: pre-filling the rendered label meant a blur silently pinned
    // presentation text ("New tab", or a de-dup suffix) as the user's own name.
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("New tab");
    expect(input.maxLength).toBe(MAX_PINNED_NAME);
    // The chip stands down while the field owns it.
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[0];
    expect(chip?.draggable).toBe(false);
    expect(chip?.hasAttribute("role")).toBe(false);
    expect(chip?.classList.contains("wt-tab-editing")).toBe(true);

    input.value = "auth work";
    pressEnter(input);
    await until(() => field(root) === null);
    expect(labels(root)[0]).toBe("auth work");
    const puts = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes("/pinned-title") && (c[1]?.method ?? "") === "PUT",
    );
    expect(puts).toHaveLength(1);
    expect(String(puts[0]?.[1]?.body)).toContain("auth work");
    // The chip's tab semantics come back.
    expect(chip?.getAttribute("role")).toBe("tab");
    expect(chip?.draggable).toBe(true);
  });

  it("opens on double-click and on F2", async () => {
    const root = document.createElement("div");
    await mount(root);
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[0];

    chip?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(field(root)).not.toBeNull();
    field(root)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(field(root)).toBeNull();

    chip?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }),
    );
    expect(field(root)).not.toBeNull();
  });

  it("reverts on Escape without issuing a request", async () => {
    const root = document.createElement("div");
    await mount(root);
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "discarded";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(field(root)).toBeNull();
    expect(labels(root)[0]).toBe("New tab");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/pinned-title"))).toBe(false);
  });

  it("commits a non-empty value on blur", async () => {
    const root = document.createElement("div");
    await mount(root);
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "blurred name";
    input.dispatchEvent(new FocusEvent("blur"));
    await until(() => labels(root)[0] === "blurred name");
    expect(labels(root)[0]).toBe("blurred name");
  });

  it("clears the pin on an emptied Enter but NOT on an emptied blur", async () => {
    listBody = [
      {
        id: "s1",
        title: "",
        pinnedTitle: "pinned",
        createdAt: "1",
        status: "idle",
      },
    ];
    const root = document.createElement("div");
    await mount(root);
    expect(labels(root)).toEqual(["pinned"]);

    // Blur with an empty field: a blur is loss of focus, not a destructive
    // confirmation (dismissing a tablet's soft keyboard IS a blur).
    item(openMenu(root, 0), "Rename\u2026")?.click();
    let input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "";
    input.dispatchEvent(new FocusEvent("blur"));
    await Promise.resolve();
    expect(labels(root)).toEqual(["pinned"]);
    expect(fetchMock.mock.calls.some((c) => (c[1]?.method ?? "") === "DELETE")).toBe(false);

    // Enter with an empty field: three deliberate actions, so it clears.
    item(openMenu(root, 0), "Rename\u2026")?.click();
    input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "   ";
    pressEnter(input);
    await until(() => labels(root)[0] === "New tab");
    expect(labels(root)).toEqual(["New tab"]);
    const dels = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes("/pinned-title") && (c[1]?.method ?? "") === "DELETE",
    );
    expect(dels).toHaveLength(1);
  });

  it("enables Use automatic name only with a pin, and clearing reveals the source below", async () => {
    listBody = [
      {
        id: "s1",
        title: "derived label",
        pinnedTitle: "my name",
        createdAt: "1",
        status: "idle",
      },
    ];
    const root = document.createElement("div");
    await mount(root);
    expect(labels(root)).toEqual(["my name"]);

    const items = openMenu(root, 0);
    expect(item(items, "Use automatic name")?.disabled).toBe(false);
    item(items, "Use automatic name")?.click();
    await until(() => labels(root)[0] === "derived label");
    // The pin MASKS the automatic title rather than replacing it, so clearing
    // reveals a real name instead of "New tab".
    expect(labels(root)).toEqual(["derived label"]);
    expect(item(openMenu(root, 0), "Use automatic name")?.disabled).toBe(true);
  });

  it("toasts and reverts when the rename cannot be persisted", async () => {
    const root = document.createElement("div");
    await mount(root);
    pinnedFail = true;

    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "doomed";
    pressEnter(input);
    // Optimistic first...
    expect(labels(root)[0]).toBe("doomed");
    // ...then rolled back, because a rename that looks applied and is lost on
    // reload is worse than a visible failure.
    await until(() => labels(root)[0] === "New tab");
    expect(labels(root)[0]).toBe("New tab");
    expect(root.textContent).toContain("Couldn't save the terminal name");
  });

  it("does not roll back when a newer change superseded the failed one", async () => {
    const root = document.createElement("div");
    await mount(root);
    pinnedFail = true;

    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "first";
    pressEnter(input);
    // A second rename lands before the first request's rejection is handled.
    pinnedFail = false;
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const second = field(root);
    if (!second) {
      throw new Error("no rename field for the second edit");
    }
    second.value = "second";
    pressEnter(second);

    await until(() => false, 10); // let both promises settle
    expect(labels(root)[0]).toBe("second");
  });

  it("keeps the failure path alive when the server merely echoes our own rename", async () => {
    // The wire carries pinnedTitle on EVERY status event, so a status update that
    // repeats the value we just set must not count as superseding: if it did, an
    // in-flight rename's failure would neither roll back nor explain itself.
    const root = document.createElement("div");
    await mount(root);
    pinnedFail = true;

    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "echoed";
    pressEnter(input);
    // The poll's reconcile applies a listing that carries the same optimistic
    // value back to us, mid-flight.
    listBody = [
      {
        id: "s1",
        title: "",
        pinnedTitle: "echoed",
        createdAt: "1",
        status: "idle",
      },
      { id: "s2", title: "", createdAt: "2", status: "idle" },
    ];
    await until(() => labels(root)[0] === "New tab", 20);
    expect(labels(root)[0]).toBe("New tab");
    expect(root.textContent).toContain("Couldn't save the terminal name");
  });

  it("stands the chip's own handlers down while editing", async () => {
    const root = document.createElement("div");
    await mount(root);
    // Start on tab 1 so a stray switch to tab 0 would be observable.
    const chips = root.querySelectorAll<HTMLElement>(".wt-tab");
    chips[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(chips[1]?.classList.contains("wt-tab-active")).toBe(true);

    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    // A click inside the field must not switch to the edited tab...
    input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(chips[1]?.classList.contains("wt-tab-active")).toBe(true);
    // ...arrows must not change tabs...
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    expect(chips[1]?.classList.contains("wt-tab-active")).toBe(true);
    // ...and Delete must not close the tab.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await Promise.resolve();
    expect(root.querySelectorAll(".wt-tab")).toHaveLength(2);
    // A drag is refused outright.
    const drag = new Event("dragstart", { bubbles: true, cancelable: true });
    chips[0]?.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
  });

  it("leaves the browser's own text menu and middle-click alone while editing", async () => {
    const root = document.createElement("div");
    await mount(root);
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[0];
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }

    // Right-click inside the field belongs to the browser: that is where Paste,
    // Select All and Undo live. Opening the tab menu there would also offer Close
    // and Move mid-edit.
    const menuEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    input.dispatchEvent(menuEvent);
    expect(menuEvent.defaultPrevented).toBe(false);
    expect(root.querySelector(".wt-tab-menu")?.classList.contains("visible")).toBe(false);

    // Middle-click pastes the primary selection on X11; it must not close the tab.
    input.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    await until(() => false, 3);
    expect(root.querySelectorAll(".wt-tab")).toHaveLength(2);
    expect(field(root)).not.toBeNull();
    expect(chip).toBeTruthy();
  });

  it("resolves an open edit under the blur rules when a reorder reparents the field", async () => {
    const root = document.createElement("div");
    await mount(root);
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "moved while editing";
    // Reordering re-appends every chip, which blurs the focused field. The
    // feature resolves the edit itself so the outcome is chosen rather than left
    // to whichever blur the reparent happens to raise.
    item(openMenu(root, 1), "Move left")?.click();
    expect(field(root)).toBeNull();
    await until(() => labels(root).includes("moved while editing"));
    expect(labels(root)).toContain("moved while editing");
  });

  it("does not clear a pin when a second edit pre-empts an emptied field", async () => {
    // Pre-empting is not a confirmation, so it must follow the blur rules: an
    // emptied field reverts rather than clearing. Only Enter may clear.
    listBody = [
      {
        id: "s1",
        title: "",
        pinnedTitle: "keep me",
        createdAt: "1",
        status: "idle",
      },
      { id: "s2", title: "", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    await mount(root);
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "";
    // Open an edit on the other tab, which resolves this one.
    item(openMenu(root, 1), "Rename\u2026")?.click();
    await until(() => false, 5);
    expect(labels(root)[0]).toBe("keep me");
    expect(fetchMock.mock.calls.some((c) => (c[1]?.method ?? "") === "DELETE")).toBe(false);
  });

  it("carries the mobile text-input attributes the iPad needs", async () => {
    const root = document.createElement("div");
    await mount(root);
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    // Without these, iPadOS capitalises the first letter of every tab name and can
    // autocorrect it on commit — on the device this affordance was designed for.
    //
    // The attribute, not the IDL property, for autocapitalize: `off` and `none` are
    // synonyms in the spec and a browser canonicalises the IDL getter to `none`, so
    // reading the property back asserts the platform's spelling rather than what
    // production wrote.
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.autocapitalize).toBe("none"); // the same thing, canonicalised
    expect(input.spellcheck).toBe(false);
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.enterKeyHint).toBe("done");
  });

  it("closes the screen-reader narrative on a no-op commit", async () => {
    const root = document.createElement("div");
    await mount(root);
    const live = root.querySelector<HTMLElement>('[aria-live="polite"]');
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    // Enter with the field untouched changes nothing, but must still say so:
    // "Renaming X" followed by silence is indistinguishable from a stuck editor.
    // The announcer clears the region synchronously and re-sets it after ~100ms
    // (so repeats re-announce), so the message needs the timer to land.
    pressEnter(input);
    await new Promise((r) => setTimeout(r, 150));
    expect(live?.textContent).toContain("Rename finished, keeping New tab");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/pinned-title"))).toBe(false);
  });

  it("abandons an open edit on teardown without issuing a request", async () => {
    const root = document.createElement("div");
    await mount(root);
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "never sent";

    term?.destroy();
    term = undefined;
    await Promise.resolve();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/pinned-title"))).toBe(false);
  });

  it("does not pin the rendered label when the editor is opened and abandoned", async () => {
    // The regression this file's earlier draft encoded: opening the editor on an
    // unpinned tab and clicking away used to commit the DISPLAY text, silently
    // pinning "New tab" (or a de-duplication suffix) as a user-chosen name.
    const root = document.createElement("div");
    await mount(root);
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.dispatchEvent(new FocusEvent("blur"));
    await until(() => false, 5);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/pinned-title"))).toBe(false);
    expect(labels(root)[0]).toBe("New tab");
    expect(openMenu(root, 0).find((b) => b.textContent === "Use automatic name")?.disabled).toBe(
      true,
    );
  });

  it("returns focus to the chip for a keyboard edit and to the terminal otherwise", async () => {
    const root = document.createElement("div");
    await mount(root);
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[0];
    const termInput = root.querySelector<HTMLTextAreaElement>(".term-input");

    // F2 means the user was navigating the strip; keep them there (R9).
    chip?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }),
    );
    field(root)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe(chip);

    // The menu path was already heading to the terminal.
    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "via menu";
    pressEnter(input);
    await until(() => labels(root)[0] === "via menu");
    expect(document.activeElement).toBe(termInput);
  });

  it("abandons an open edit when a bulk close removes its tab", async () => {
    vi.stubGlobal("confirm", () => true);
    const root = document.createElement("div");
    await mount(root);
    // Edit tab 2, then close it via the bulk path (Close others from tab 1), which
    // drops tabs itself rather than through dropTab.
    const chips = root.querySelectorAll<HTMLElement>(".wt-tab");
    chips[1]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(field(root)).not.toBeNull();

    item(openMenu(root, 0), "Close others")?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    // No orphaned field, and no request for the vanished tab's name.
    expect(field(root)).toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/pinned-title"))).toBe(false);
    // editingId is clear, so focus-on-switch works again: switching announces and
    // the surviving tab is selectable.
    const survivor = root.querySelector<HTMLElement>(".wt-tab");
    expect(survivor?.getAttribute("role")).toBe("tab");
  });

  it("keeps the editing chip free of tab semantics across a chrome repaint", async () => {
    const root = document.createElement("div");
    await mount(root);
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[0];
    item(openMenu(root, 0), "Rename\u2026")?.click();
    expect(chip?.hasAttribute("role")).toBe(false);

    // syncChrome repaints the active state and runs on every status event, every
    // switch and every close. It must not re-add aria-selected / the roving
    // tabindex to a chip hosting a textbox. Switching to the OTHER tab is the
    // synchronous way to force that repaint while the edit stays open.
    root
      .querySelectorAll<HTMLElement>(".wt-tab")[1]
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(chip?.hasAttribute("role")).toBe(false);
    expect(chip?.hasAttribute("aria-selected")).toBe(false);

    // And the semantics come back on exit, from the CURRENT selected state —
    // which is now the OTHER tab, so this chip must come back deselected.
    field(root)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(chip?.getAttribute("role")).toBe("tab");
    expect(chip?.getAttribute("aria-selected")).toBe("false");
  });

  it("keeps a long-pressed tab menu open through the release click (iPadOS)", async () => {
    const root = document.createElement("div");
    await mount(root);
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[0];
    const visible = (): boolean =>
      root.querySelector(".wt-tab-menu")?.classList.contains("visible") ?? false;

    // iPadOS Safari raises a context menu from a LONG-PRESS, and the release of
    // that same press emits a click. Reading it as a click-away closed the menu
    // the instant the finger came up, so the tab menu was unusable by touch on
    // the one platform where the desktop strip is the chrome you touch.
    const touchDown = new Event("pointerdown", { bubbles: true }) as unknown as PointerEvent;
    Object.defineProperty(touchDown, "pointerType", { value: "touch" });
    chip?.dispatchEvent(touchDown);
    chip?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(visible()).toBe(true);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(visible()).toBe(true);
  });

  // Its own mount, because the swallow window is a real elapsed-time window: a
  // mouse assertion sharing the touch test's mount would still be inside it.
  it("still dismisses a mouse-opened tab menu on a click away", async () => {
    const root = document.createElement("div");
    await mount(root);
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[0];
    const visible = (): boolean =>
      root.querySelector(".wt-tab-menu")?.classList.contains("visible") ?? false;

    // A mouse right-click emits no trailing click, so nothing may be swallowed
    // there — the swallow must be armed by pointer type, not by every open.
    const mouseDown = new Event("pointerdown", { bubbles: true }) as unknown as PointerEvent;
    Object.defineProperty(mouseDown, "pointerType", { value: "mouse" });
    chip?.dispatchEvent(mouseDown);
    chip?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(visible()).toBe(true);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(visible()).toBe(false);
  });
});

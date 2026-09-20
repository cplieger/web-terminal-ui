import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import { presetTabbed } from "../presets/tabbed.js";
import type { PaneLayout } from "../features/tabs/model.js";
import type { TerminalContext, TerminalFeature } from "./types.js";

const { fake, connectStatusStream } = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../test-helpers/fake-engine.js");
  const { vi: v } = await import("vitest");
  return {
    fake: createEngineFake(),
    connectStatusStream: v.fn(() => ({ close: v.fn() })),
  };
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine, connectStatusStream };
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}
const layout: PaneLayout = { left: null, right: null, handle: 0.5, selected: "left", open: false };
const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (String(url).endsWith("/layout")) {
    return Promise.resolve(method === "PUT" ? jsonResponse(null, 204) : jsonResponse(layout));
  }
  return Promise.resolve(
    jsonResponse([
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ]),
  );
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await tick();
  }
}

beforeEach(() => {
  fake.reset();
  connectStatusStream.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  document.body.replaceChildren();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function rootIn(): HTMLElement {
  const root = document.createElement("div");
  root.style.width = "1000px";
  root.style.height = "600px";
  document.body.appendChild(root);
  return root;
}

const encoder = new TextEncoder();

describe("shell-scoped features run once", () => {
  it("sets the shared features up once and the pane features once per pane, builds the chrome once, and routes the toolbar to the selected pane", async () => {
    let thunkCalls = 0;
    const setups = new Map<string, number>();
    const funnel: string[] = [];
    let shell: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "shell-probe",
      scope: "shell",
      setup(ctx) {
        shell = ctx;
        return { api: undefined, teardown: () => undefined };
      },
    };
    const witness = (): TerminalFeature<void> => ({
      name: "witness",
      setup(ctx) {
        const side = (): string => (ctx.surface().closest(".wt-side-left") ? "left" : "right");
        ctx.registerInputObserver((bytes) => {
          funnel.push(`${side()}:${Array.from(bytes).join(",")}`);
        });
        return { api: undefined, teardown: () => undefined };
      },
    });
    const counted = (features: TerminalFeature<unknown>[]): TerminalFeature<unknown>[] =>
      features.map((f) => ({
        ...f,
        setup(ctx) {
          setups.set(f.name, (setups.get(f.name) ?? 0) + 1);
          return f.setup(ctx);
        },
      }));

    const root = rootIn();
    const term = await mountTerminal(root, {
      split: true,
      features: () => {
        thunkCalls++;
        return [probe, ...counted(presetTabbed()), witness()];
      },
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    await until(() => shell?.shell.pane("left")?.state() === "shown");
    if (!shell) {
      throw new Error("the probe never ran");
    }
    expect(thunkCalls).toBe(1);

    expect(term.split?.open()).toBe(true);
    await tick();
    expect(thunkCalls).toBe(2);
    expect(setups.get("tabs")).toBe(1);
    expect(setups.get("mobileToolbar")).toBe(1);
    expect(setups.get("activityMonitor")).toBe(1);
    expect(setups.get("animations")).toBe(1);
    expect(setups.get("contextMenu")).toBe(2);
    expect(setups.get("connectionBanner")).toBe(2);
    expect(connectStatusStream).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll(".key-toolbar")).toHaveLength(1);
    expect(root.querySelectorAll(".wt-tab-bar")).toHaveLength(1);
    const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Fill the right pane and select it: the toolbar's Escape goes there alone.
    root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.click();
    expect(shell.shell.selected()).toBe("right");
    const esc = root.querySelector<HTMLElement>("#kb-esc");
    esc?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(funnel).toEqual(["right:27"]);

    shell.shell.select("left");
    esc?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(funnel).toEqual(["right:27", "left:27"]);

    // Sticky Ctrl rewrites a byte typed in either pane.
    funnel.length = 0;
    const ctrl = root.querySelector<HTMLElement>("#kb-ctrl");
    ctrl?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    shell.shell.pane("left")?.send(encoder.encode("a"));
    expect(funnel).toEqual(["left:1"]);
    ctrl?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    shell.shell.pane("right")?.send(encoder.encode("c"));
    expect(funnel).toEqual(["left:1", "right:3"]);
    shell.shell.pane("right")?.send(encoder.encode("c"));
    expect(funnel).toEqual(["left:1", "right:3", "right:99"]);
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { POWER_ON_MODES, createModeState } from "@cplieger/web-terminal-engine";
import type { FeatureInstance, TerminalContext } from "../kernel/types.js";
import { mobileToolbar, type MobileToolbarApi } from "./mobile-toolbar.js";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

const MANIFESTS = import.meta.glob("../../css/MANIFEST*", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SHEETS = import.meta.glob("../../css/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const byName = (mods: Record<string, string>): Map<string | undefined, string> =>
  new Map(Object.entries(mods).map(([p, text]) => [p.split("/").pop(), text]));

const TOUCH_BUNDLE = ((): string => {
  const manifest = byName(MANIFESTS).get("MANIFEST.touch");
  if (manifest === undefined) {
    throw new Error("css/MANIFEST.touch is missing");
  }
  const sheets = byName(SHEETS);
  return manifest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((name) => {
      const text = sheets.get(name);
      if (text === undefined) {
        throw new Error(`css/MANIFEST.touch names ${name}, which css/ does not contain`);
      }
      return text;
    })
    .join("\n");
})();

let styles: HTMLStyleElement;
let root: HTMLElement | null = null;

beforeAll(() => {
  styles = document.createElement("style");
  styles.textContent = TOUCH_BUNDLE;
  document.head.appendChild(styles);
});

afterAll(() => {
  styles.remove();
});

afterEach(() => {
  root?.remove();
  root = null;
});

async function mount(
  opts: Parameters<typeof mobileToolbar>[0],
): Promise<{ toolbar: HTMLElement; api: MobileToolbarApi }> {
  expect(matchMedia("(pointer: coarse)").matches, "this project's primary pointer").toBe(true);
  const host = document.createElement("div");
  host.className = "wt-root wt-container";
  host.style.height = "400px";
  document.body.appendChild(host);
  root = host;
  const ctx = {
    region: () => host,
    shell: { root: host },
    send: () => undefined,
    modes: createModeState(POWER_ON_MODES),
    registerInputTransform: () => () => undefined,
    defer: () => undefined,
  } as unknown as TerminalContext;
  const inst = (await mobileToolbar(opts).setup(ctx)) as FeatureInstance<MobileToolbarApi>;
  const toolbar = host.querySelector<HTMLElement>(".key-toolbar");
  expect(toolbar, "the feature built its toolbar").not.toBeNull();
  return { toolbar: toolbar!, api: inst.api! };
}

describe("the key grid under a coarse primary pointer", () => {
  it("shows a self-toggled toolbar's collapsed pill and its own toggle", async () => {
    const { toolbar } = await mount({});
    expect(getComputedStyle(toolbar).display).toBe("grid");
    expect(toolbar.querySelector<HTMLElement>("#kb-toggle")!.checkVisibility()).toBe(true);
  });

  it("draws nothing for an externally toggled grid while it is collapsed", async () => {
    const { toolbar } = await mount({ externalToggle: true });
    expect(getComputedStyle(toolbar).display).toBe("none");
  });

  it("opens an externally toggled grid in four columns, with no toggle of its own", async () => {
    const { toolbar, api } = await mount({ externalToggle: true });
    api.toggle();
    expect(getComputedStyle(toolbar).display).toBe("grid");
    expect(getComputedStyle(toolbar).gridTemplateColumns.split(" ")).toHaveLength(4);
    expect(getComputedStyle(toolbar.querySelector("#kb-toggle")!).display).toBe("none");
  });
});

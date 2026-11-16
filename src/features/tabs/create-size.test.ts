// A create tells the server the grid of the pane its tab opens in, so a program
// that reads its width once at start is laid out at that width rather than at
// the server's 80-column default. Driven through the real feature and kernel;
// the engine fake's renderer measures the grid, and fetch is the only network
// fake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { rootIn, shown, until } from "./test-helpers/split.js";
import {
  created,
  mountScripted,
  ok,
  refuse,
  row,
  scriptedServer,
  type ScriptedServer,
} from "./test-helpers/scripted.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const A = row("A", "tab_A", "1");
const GRID = { cols: 47, rows: 31 };

let server: ScriptedServer;

beforeEach(() => {
  fake.reset();
  fake.renderer.computeSize.mockReturnValue(GRID);
  server = scriptedServer();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The body of every POST /api/sessions, in arrival order. */
function createBodies(): (BodyInit | null | undefined)[] {
  return server.fetch.mock.calls
    .filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/sessions"))
    .map(([, init]) => init?.body);
}

describe("a create carries the size of the pane it opens in", () => {
  it("the boot create carries the landing pane's grid", async () => {
    server.list = [ok([])];
    const m = await mountScripted(rootIn(1000));

    await until(() => shown(m.ctx(), "left") !== null, 120);
    expect(createBodies()).toEqual([JSON.stringify(GRID)]);
  });

  it("a boot create retried after a 503 measures the pane again", async () => {
    const later = { cols: 52, rows: 33 };
    server.list = [ok([])];
    server.post = [refuse(), created({ id: "s-new", title: "", createdAt: "9", status: "idle" })];
    server.onRequest = (method) => {
      if (method === "POST") {
        fake.renderer.computeSize.mockReturnValue(later);
      }
    };
    const m = await mountScripted(rootIn(1000));

    await until(() => shown(m.ctx(), "left") !== null, 120);
    expect(createBodies()).toEqual([JSON.stringify(GRID), JSON.stringify(later)]);
  });

  it("a + create in the single view carries the selected pane's grid", async () => {
    server.list = [ok([A])];
    const m = await mountScripted(rootIn(1000));
    await until(() => shown(m.ctx(), "left") !== null, 120);

    await m.api.create();

    expect(createBodies()).toEqual([JSON.stringify(GRID)]);
  });

  it("a create whose pane opens with the split sends no size", async () => {
    server.list = [ok([A])];
    const m = await mountScripted(rootIn(1000));
    await until(() => shown(m.ctx(), "left") !== null, 120);

    expect(m.api.snap("A", "left")).toBe(true);
    await until(() => createBodies().length === 1, 120);
    await until(() => shown(m.ctx(), "right") !== null, 120);

    expect(createBodies()).toEqual([undefined]);
  });
});

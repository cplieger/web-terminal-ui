// Shell contract tests: the page-level facts a feature reaches through ctx.shell.
// Exercised through throwaway features that capture their context, so this pins
// the SHELL's contract and not any built-in feature's use of it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { StatusStreamCallbacks } from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import type { TerminalContext, TerminalFeature, TerminalHandle } from "./types.js";

const { fake, streams, connectStatusStream } = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../test-helpers/fake-engine.js");
  const streams: { path: string; callbacks: StatusStreamCallbacks; close: () => void }[] = [];
  const connectStatusStream = vi.fn((path: string, callbacks: StatusStreamCallbacks) => {
    const close = vi.fn();
    streams.push({ path, callbacks, close });
    return { close };
  });
  return { fake: createEngineFake(), streams, connectStatusStream };
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine, connectStatusStream };
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fake.reset();
  streams.length = 0;
  connectStatusStream.mockClear();
  document.body.replaceChildren();
});

/** Mount a terminal carrying one shell-scoped feature that captures its context. */
async function mountWithProbe(): Promise<{ ctx: TerminalContext; term: TerminalHandle }> {
  let ctxRef: TerminalContext | undefined;
  const probe: TerminalFeature<void> = {
    name: "shell-probe",
    scope: "shell",
    setup(ctx) {
      ctxRef = ctx;
      return { api: undefined, teardown: vi.fn() };
    },
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  const term = await mountTerminal(root, { features: () => [probe] });
  await tick();
  if (!ctxRef) {
    throw new Error("the probe feature never ran");
  }
  return { ctx: ctxRef, term };
}

function closeCalls(): number[] {
  return streams.map((s) => (s.close as ReturnType<typeof vi.fn>).mock.calls.length);
}

describe("ctx.shell.subscribeStatus: one stream per page", () => {
  it("opens the stream at the given path once for two subscribers and delivers to both", async () => {
    const { ctx } = await mountWithProbe();
    const a = vi.fn();
    const b = vi.fn();
    ctx.shell.subscribeStatus("/api/sessions/events", { onStatus: a });
    ctx.shell.subscribeStatus("/api/sessions/events", { onStatus: b });

    expect(connectStatusStream).toHaveBeenCalledTimes(1);
    expect(streams[0]?.path).toBe("/api/sessions/events");
    streams[0]?.callbacks.onStatus({
      id: "s1",
      status: "working",
      title: "",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("feature first: a subscription handed to ctx.defer is released by destroy, and the stream closes exactly once", async () => {
    const { ctx, term } = await mountWithProbe();
    ctx.defer(ctx.shell.subscribeStatus("/api/sessions/events", { onStatus: vi.fn() }));
    expect(closeCalls()).toEqual([0]);

    term.destroy();
    expect(closeCalls()).toEqual([1]);
  });

  it("shell first: destroy closes a stream whose subscriber never unsubscribed, exactly once, and the late unsubscribe closes nothing more", async () => {
    const { ctx, term } = await mountWithProbe();
    const off = ctx.shell.subscribeStatus("/api/sessions/events", { onStatus: vi.fn() });

    term.destroy();
    expect(closeCalls()).toEqual([1]);

    expect(() => off()).not.toThrow();
    expect(closeCalls()).toEqual([1]);
  });

  it("the last unsubscribe closes the stream before destroy, and destroy closes nothing more", async () => {
    const { ctx, term } = await mountWithProbe();
    const off = ctx.shell.subscribeStatus("/api/sessions/events", { onStatus: vi.fn() });

    off();
    expect(closeCalls()).toEqual([1]);

    term.destroy();
    expect(closeCalls()).toEqual([1]);
  });
});

describe("ctx.shell.notifications: one notifier per page", () => {
  /** Two shell-scoped features capturing their contexts, in setup order. */
  async function mountWithTwoProbes(): Promise<[TerminalContext, TerminalContext]> {
    const captured: TerminalContext[] = [];
    const probe = (name: string): TerminalFeature<void> => ({
      name,
      scope: "shell",
      setup(ctx) {
        captured.push(ctx);
        return { api: undefined, teardown: vi.fn() };
      },
    });
    const root = document.createElement("div");
    document.body.appendChild(root);
    await mountTerminal(root, { features: () => [probe("first"), probe("second")] });
    await tick();
    const [a, b] = captured;
    if (!a || !b) {
      throw new Error("a probe feature never ran");
    }
    return [a, b];
  }

  it("asks for permission once for the page: one feature arms it, another's gesture prompts, a repeat does not", async () => {
    const requestPermission = vi.fn();
    class FakeNotification {
      static permission = "default";
      static requestPermission = requestPermission;
    }
    vi.stubGlobal("Notification", FakeNotification);
    const [a, b] = await mountWithTwoProbes();

    b.shell.notifications.gesture();
    expect(requestPermission).not.toHaveBeenCalled();

    a.shell.notifications.arm();
    b.shell.notifications.gesture();
    expect(requestPermission).toHaveBeenCalledTimes(1);

    a.shell.notifications.gesture();
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("posts through the browser's Notification with the view's label as the title", async () => {
    const posts: { title: string; body: string | undefined }[] = [];
    class FakeNotification {
      static permission = "granted";
      constructor(title: string, options?: { body?: string }) {
        posts.push({ title, body: options?.body });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    const [a] = await mountWithTwoProbes();

    const posted = a.shell.notifications.deliver(
      { id: "s1", notification: "Response complete", notificationSeq: 1 },
      { sessionIsActive: false, label: "agent", activate: vi.fn() },
    );
    expect(posted).toBe(true);
    expect(posts).toEqual([{ title: "agent", body: "Response complete" }]);
  });
});

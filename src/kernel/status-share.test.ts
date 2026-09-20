// kernel/status-share.ts tests: the one-stream-per-path rule, the fan-out, and
// the two ways a stream is closed (the last subscriber leaving, and dispose).

import { describe, it, expect, vi } from "vitest";
import type { SessionStatus, StatusStreamCallbacks } from "@cplieger/web-terminal-engine";
import { createStatusShare, type StatusShare } from "./status-share.js";

interface FakeStream {
  readonly path: string;
  readonly callbacks: StatusStreamCallbacks;
  readonly close: ReturnType<typeof vi.fn>;
}

/** A share over a recording connector: every stream it opened, oldest first. */
function harness(): { share: StatusShare; streams: FakeStream[] } {
  const streams: FakeStream[] = [];
  const share = createStatusShare((path, callbacks) => {
    const close = vi.fn();
    streams.push({ path, callbacks, close });
    return { close };
  });
  return { share, streams };
}

const status = (id: string): SessionStatus => ({
  id,
  status: "working",
  title: "",
  createdAt: "2026-01-01T00:00:00Z",
});

function only(streams: FakeStream[]): FakeStream {
  expect(streams).toHaveLength(1);
  const s = streams[0];
  if (!s) {
    throw new Error("no stream");
  }
  return s;
}

describe("status share: one stream per path", () => {
  it("opens one stream for two subscribers of the same path and fans every event out to both", () => {
    const { share, streams } = harness();
    const seen: string[] = [];
    share.subscribe("/events", { onStatus: (s) => seen.push(`a:${s.id}`) });
    share.subscribe("/events", { onStatus: (s) => seen.push(`b:${s.id}`) });

    const stream = only(streams);
    expect(stream.path).toBe("/events");
    stream.callbacks.onStatus(status("s1"));
    expect(seen).toEqual(["a:s1", "b:s1"]);
  });

  it("opens a second stream for a second path", () => {
    const { share, streams } = harness();
    share.subscribe("/events", { onStatus: vi.fn() });
    share.subscribe("/other/events", { onStatus: vi.fn() });
    expect(streams.map((s) => s.path)).toEqual(["/events", "/other/events"]);
  });

  it("forwards open and error to every subscriber", () => {
    const { share, streams } = harness();
    const a = { onStatus: vi.fn(), onOpen: vi.fn(), onError: vi.fn() };
    const b = { onStatus: vi.fn(), onOpen: vi.fn(), onError: vi.fn() };
    share.subscribe("/events", a);
    share.subscribe("/events", b);

    only(streams).callbacks.onOpen?.();
    only(streams).callbacks.onError?.();
    expect(a.onOpen).toHaveBeenCalledTimes(1);
    expect(b.onOpen).toHaveBeenCalledTimes(1);
    expect(a.onError).toHaveBeenCalledTimes(1);
    expect(b.onError).toHaveBeenCalledTimes(1);
  });

  it("calls a late subscriber's onOpen at once when the stream has already opened", () => {
    const { share, streams } = harness();
    const early = { onStatus: vi.fn(), onOpen: vi.fn() };
    share.subscribe("/events", early);
    expect(early.onOpen).not.toHaveBeenCalled();

    only(streams).callbacks.onOpen?.();
    const late = { onStatus: vi.fn(), onOpen: vi.fn() };
    share.subscribe("/events", late);
    expect(late.onOpen).toHaveBeenCalledTimes(1);
    expect(early.onOpen).toHaveBeenCalledTimes(1);
  });

  it("a late subscriber whose immediate onOpen throws is still subscribed and still owns its unsubscribe", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { share, streams } = harness();
    const offEarly = share.subscribe("/events", { onStatus: vi.fn() });
    only(streams).callbacks.onOpen?.();

    const late = {
      onStatus: vi.fn(),
      onOpen: () => {
        throw new Error("boom");
      },
    };
    let offLate: (() => void) | undefined;
    expect(() => {
      offLate = share.subscribe("/events", late);
    }).not.toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
    only(streams).callbacks.onStatus(status("s1"));
    expect(late.onStatus).toHaveBeenCalledTimes(1);

    offEarly();
    expect(only(streams).close).not.toHaveBeenCalled();
    offLate?.();
    expect(only(streams).close).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("keeps delivering to the peer of a subscriber that throws", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { share, streams } = harness();
    const peer = vi.fn();
    share.subscribe("/events", {
      onStatus: () => {
        throw new Error("boom");
      },
    });
    share.subscribe("/events", { onStatus: peer });

    expect(() => only(streams).callbacks.onStatus(status("s1"))).not.toThrow();
    expect(peer).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe("status share: the stream closes when its subscriber count reaches zero", () => {
  it("first subscriber out, then the second: the stream closes once, at the second", () => {
    const { share, streams } = harness();
    const offA = share.subscribe("/events", { onStatus: vi.fn() });
    const offB = share.subscribe("/events", { onStatus: vi.fn() });
    const stream = only(streams);

    offA();
    expect(stream.close).not.toHaveBeenCalled();
    offB();
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it("second subscriber out, then the first: the stream closes once, at the first", () => {
    const { share, streams } = harness();
    const offA = share.subscribe("/events", { onStatus: vi.fn() });
    const offB = share.subscribe("/events", { onStatus: vi.fn() });
    const stream = only(streams);

    offB();
    expect(stream.close).not.toHaveBeenCalled();
    offA();
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it("an unsubscribed callback receives nothing more while its peer still does", () => {
    const { share, streams } = harness();
    const a = vi.fn();
    const b = vi.fn();
    const offA = share.subscribe("/events", { onStatus: a });
    share.subscribe("/events", { onStatus: b });

    offA();
    only(streams).callbacks.onStatus(status("s1"));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a second call of one unsubscribe releases nothing: the peer's stream stays open", () => {
    const { share, streams } = harness();
    const offA = share.subscribe("/events", { onStatus: vi.fn() });
    share.subscribe("/events", { onStatus: vi.fn() });

    offA();
    offA();
    expect(only(streams).close).not.toHaveBeenCalled();
  });

  it("a subscribe after the last unsubscribe opens a fresh stream", () => {
    const { share, streams } = harness();
    const off = share.subscribe("/events", { onStatus: vi.fn() });
    off();
    share.subscribe("/events", { onStatus: vi.fn() });

    expect(streams).toHaveLength(2);
    expect(streams[0]?.close).toHaveBeenCalledTimes(1);
    expect(streams[1]?.close).not.toHaveBeenCalled();
  });
});

describe("status share: dispose", () => {
  it("closes every open stream once, and a later unsubscribe closes nothing again", () => {
    const { share, streams } = harness();
    const offA = share.subscribe("/events", { onStatus: vi.fn() });
    share.subscribe("/other/events", { onStatus: vi.fn() });

    share.dispose();
    expect(streams.map((s) => s.close.mock.calls.length)).toEqual([1, 1]);

    expect(() => offA()).not.toThrow();
    expect(streams.map((s) => s.close.mock.calls.length)).toEqual([1, 1]);
  });

  it("delivers nothing that arrives after dispose", () => {
    const { share, streams } = harness();
    const seen = vi.fn();
    share.subscribe("/events", { onStatus: seen });

    share.dispose();
    only(streams).callbacks.onStatus(status("late"));
    expect(seen).not.toHaveBeenCalled();
  });
});

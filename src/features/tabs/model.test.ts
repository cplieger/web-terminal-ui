/** Session-API error contract.
 *
 *  These pin what a caller can LEARN from a failed session call, which is the
 *  whole point of SessionAPIError: a host may refuse session creation
 *  temporarily and say so (web-terminal-kiro answers 503 + Retry-After while its
 *  tool engine installs on first boot). Flattening that into a message string
 *  made it indistinguishable from a 500 and threw away the retry hint. */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { CueStatus } from "./model.js";
import {
  MAX_PERSISTED_CUE_SEEN,
  MAX_PERSISTED_TAB_ORDER,
  PROGRESS_ABSENT,
  SessionAPIError,
  createSessionAPI,
  isCueStatus,
  isEndedStatus,
  normalizeProgress,
  orderedInsertIndex,
  parseCueSeen,
  parseTabOrder,
  renderedProgress,
  serializeCueSeen,
  serializeTabOrder,
  statusOwnsProgress,
  statusPhrase,
  statusRevealsDot,
  tabAccessibleName,
} from "./model.js";

function response(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function stubFetch(r: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(r)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionAPIError carries what the server said", () => {
  it("exposes the status so a caller can tell 503 from 500", async () => {
    stubFetch(response(503));
    await expect(createSessionAPI("/api/sessions").create()).rejects.toBeInstanceOf(
      SessionAPIError,
    );
    stubFetch(response(503));
    await createSessionAPI("/api/sessions")
      .create()
      .catch((err: unknown) => {
        expect((err as SessionAPIError).status).toBe(503);
      });
  });

  it("parses Retry-After delta-seconds into milliseconds", async () => {
    stubFetch(response(503, {}, { "Retry-After": "5" }));
    await createSessionAPI("/api/sessions")
      .create()
      .catch((err: unknown) => {
        expect((err as SessionAPIError).retryAfterMs).toBe(5000);
      });
  });

  it("parses an HTTP-date Retry-After and never returns a negative delay", async () => {
    const past = new Date(Date.now() - 60000).toUTCString();
    stubFetch(response(503, {}, { "Retry-After": past }));
    await createSessionAPI("/api/sessions")
      .create()
      .catch((err: unknown) => {
        // A date already in the past means "retry now", not "never".
        expect((err as SessionAPIError).retryAfterMs).toBe(0);
      });
  });

  it("clamps an absurd Retry-After so a bad header cannot park the UI", async () => {
    stubFetch(response(503, {}, { "Retry-After": "99999" }));
    await createSessionAPI("/api/sessions")
      .create()
      .catch((err: unknown) => {
        expect((err as SessionAPIError).retryAfterMs).toBe(60000);
      });
  });

  it("ignores a missing or unparseable Retry-After", async () => {
    for (const headers of [{}, { "Retry-After": "soon" }, { "Retry-After": "  " }]) {
      stubFetch(response(503, {}, headers));
      await createSessionAPI("/api/sessions")
        .create()
        .catch((err: unknown) => {
          expect((err as SessionAPIError).retryAfterMs).toBeUndefined();
        });
    }
  });

  it("surfaces the envelope's message so the host's own words reach the user", async () => {
    // The first-party Go envelope (webhttp ErrorResponse) writes `error`; this is
    // the field every server in this family actually returns, and the shape
    // web-terminal-kiro's tools-installing 503 uses.
    stubFetch(response(503, { error: "tools installing", code: "", request_id: "abc" }));
    await createSessionAPI("/api/sessions")
      .create()
      .catch((err: unknown) => {
        expect((err as SessionAPIError).serverMessage).toBe("tools installing");
      });
  });

  it("also accepts a `message` field, and prefers `error` when both are present", async () => {
    stubFetch(response(503, { message: "installing" }));
    await createSessionAPI("/api/sessions")
      .create()
      .catch((err: unknown) => {
        expect((err as SessionAPIError).serverMessage).toBe("installing");
      });
    stubFetch(response(503, { error: "from error", message: "from message" }));
    await createSessionAPI("/api/sessions")
      .create()
      .catch((err: unknown) => {
        expect((err as SessionAPIError).serverMessage).toBe("from error");
      });
  });

  it("caps a server message destined for UI chrome", async () => {
    stubFetch(response(503, { message: "x".repeat(400) }));
    await createSessionAPI("/api/sessions")
      .create()
      .catch((err: unknown) => {
        expect((err as SessionAPIError).serverMessage).toHaveLength(120);
      });
  });

  it("tolerates a non-JSON, empty, or hostile body without losing the status", async () => {
    const bodies: unknown[] = [null, "a string", { error: 42 }, { error: "   " }, []];
    for (const body of bodies) {
      stubFetch(response(503, body));
      await createSessionAPI("/api/sessions")
        .create()
        .catch((err: unknown) => {
          expect((err as SessionAPIError).status).toBe(503);
          expect((err as SessionAPIError).serverMessage).toBeUndefined();
        });
    }
    // A body that rejects on read (not JSON at all) must not mask the status.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          headers: { get: () => null },
          json: () => Promise.reject(new Error("not json")),
        } as unknown as Response),
      ),
    );
    await createSessionAPI("/api/sessions")
      .create()
      .catch((err: unknown) => {
        expect((err as SessionAPIError).status).toBe(503);
        expect((err as SessionAPIError).serverMessage).toBeUndefined();
      });
  });

  it("applies to list and close as well, not only create", async () => {
    stubFetch(response(500));
    await createSessionAPI("/api/sessions")
      .list()
      .catch((err: unknown) => {
        expect(err).toBeInstanceOf(SessionAPIError);
        expect((err as SessionAPIError).status).toBe(500);
      });
    stubFetch(response(404));
    await createSessionAPI("/api/sessions")
      .close("s1")
      .catch((err: unknown) => {
        expect(err).toBeInstanceOf(SessionAPIError);
        expect((err as SessionAPIError).status).toBe(404);
      });
  });
});

/** Persisted tab arrangement.
 *
 *  These pin the two properties the restore path depends on: a stored value that
 *  cannot be trusted degrades to "no arrangement" (the server's creation order is
 *  always a valid strip) rather than to a corrupted strip, and a tab is placed by
 *  the stored arrangement regardless of the order sessions ARRIVE in — which is
 *  not stable, since the status-stream snapshot races the bootstrap's list. */
describe("parseTabOrder rejects anything the restore path cannot trust", () => {
  it("reads a well-formed arrangement back verbatim", () => {
    expect(parseTabOrder(JSON.stringify(["c", "a", "b"]))).toEqual(["c", "a", "b"]);
  });

  it("degrades to no arrangement on unusable values", () => {
    const cases: Record<string, string | null> = {
      absent: null,
      empty: "",
      "not json": "{oh no",
      "an object": JSON.stringify({ a: 1 }),
      "a bare string": JSON.stringify("s1"),
      "a number": JSON.stringify(7),
      null_literal: JSON.stringify(null),
    };
    for (const [name, raw] of Object.entries(cases)) {
      expect(parseTabOrder(raw), name).toEqual([]);
    }
  });

  it("drops entries that are not usable ids, keeping the rest in order", () => {
    expect(parseTabOrder(JSON.stringify(["a", 1, "", null, "b", { id: "c" }, "d"]))).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  it("drops a duplicate id, which would make the insert position ambiguous", () => {
    expect(parseTabOrder(JSON.stringify(["a", "b", "a", "c", "b"]))).toEqual(["a", "b", "c"]);
  });

  it("caps a hostile or corrupted list so the restore cannot do unbounded work", () => {
    const huge = Array.from({ length: MAX_PERSISTED_TAB_ORDER + 500 }, (_, i) => `s${String(i)}`);
    expect(parseTabOrder(JSON.stringify(huge))).toHaveLength(MAX_PERSISTED_TAB_ORDER);
    // The write is capped the same way, so a round trip is stable: what is
    // written back is exactly what the reader would keep.
    expect(parseTabOrder(serializeTabOrder(huge))).toHaveLength(MAX_PERSISTED_TAB_ORDER);
  });

  it("round-trips through serializeTabOrder", () => {
    const ids = ["s3", "s1", "s2"];
    expect(parseTabOrder(serializeTabOrder(ids))).toEqual(ids);
  });
});

/** Persisted cue acknowledgements.
 *
 *  The dot on the mobile switch button is dismissible, but `input` and `done` are
 *  LATCHED server-side and re-pushed in every status-stream snapshot, so the
 *  dismissal only survives a reload (or an SSE reconnect) because it is stored.
 *  These pin the store's shape and its safe-degradation rule. */
describe("parseCueSeen rejects anything the acknowledgement store cannot trust", () => {
  it("reads a well-formed map back verbatim", () => {
    expect([...parseCueSeen(JSON.stringify({ s1: "done", s2: "input" }))]).toEqual([
      ["s1", "done"],
      ["s2", "input"],
    ]);
  });

  it("degrades to nothing acknowledged on unusable values", () => {
    const cases: Record<string, string | null> = {
      absent: null,
      empty: "",
      "not json": "{oh no",
      "an array": JSON.stringify(["s1"]),
      "a bare string": JSON.stringify("s1"),
      "a number": JSON.stringify(7),
      null_literal: JSON.stringify(null),
    };
    for (const [name, raw] of Object.entries(cases)) {
      expect(parseCueSeen(raw).size, name).toBe(0);
    }
  });

  it("drops entries whose value is not a cue status, keeping the rest", () => {
    // Only the two cue-worthy statuses are acknowledgeable: "working"/"idle"/
    // "exited" are states nothing ever notified about, and a stored one would
    // silently suppress the NEXT real cue for that session.
    const raw = JSON.stringify({ s1: "done", s2: "working", s3: 1, s4: "input", "": "done" });
    expect([...parseCueSeen(raw)]).toEqual([
      ["s1", "done"],
      ["s4", "input"],
    ]);
  });

  it("caps a hostile or corrupted map so the restore cannot do unbounded work", () => {
    const huge = Object.fromEntries(
      Array.from({ length: MAX_PERSISTED_CUE_SEEN + 500 }, (_, i) => [`s${String(i)}`, "done"]),
    );
    expect(parseCueSeen(JSON.stringify(huge)).size).toBe(MAX_PERSISTED_CUE_SEEN);
  });

  it("round-trips through serializeCueSeen", () => {
    const seen = new Map<string, CueStatus>([
      ["s3", "input"],
      ["s1", "done"],
    ]);
    expect([...parseCueSeen(serializeCueSeen(seen))]).toEqual([...seen]);
  });
});

describe("isCueStatus declares the cue-worthy statuses in one place", () => {
  it("accepts exactly the three states that want the user, and nothing else", () => {
    // The switcher's aggregate dot is "like a notification": it shows only the
    // states that ask something of the user. The five it must NOT show are the
    // three ongoing/informational progress states plus idle and a clean exit.
    expect(["input", "done", "crashed"].every(isCueStatus)).toBe(true);
    expect(["working", "warning", "failed", "idle", "exited", "", "DONE"].some(isCueStatus)).toBe(
      false,
    );
  });
});

describe("orderedInsertIndex places a tab by the arrangement, not by arrival", () => {
  it("rebuilds the saved arrangement from any arrival order", () => {
    const saved = ["c", "a", "b"];
    // Every permutation of arrival must converge on the same strip.
    const arrivals = [
      ["a", "b", "c"],
      ["c", "b", "a"],
      ["b", "a", "c"],
      ["a", "c", "b"],
      ["b", "c", "a"],
      ["c", "a", "b"],
    ];
    for (const order of arrivals) {
      const strip: string[] = [];
      for (const id of order) {
        strip.splice(orderedInsertIndex(strip, saved, id), 0, id);
      }
      expect(strip, order.join(">")).toEqual(saved);
    }
  });

  it("appends a session the arrangement does not know (a new tab goes last)", () => {
    expect(orderedInsertIndex(["c", "a"], ["c", "a", "b"], "zz")).toBe(2);
    expect(orderedInsertIndex([], [], "s1")).toBe(0);
  });

  it("lets a saved tab slot ahead of tabs the arrangement does not know", () => {
    // "x" is unknown to the arrangement and already at the head; "a" (rank 1)
    // still lands before "b" (rank 2) rather than being pushed to the end.
    expect(orderedInsertIndex(["x", "b"], ["c", "a", "b"], "a")).toBe(1);
  });
});

describe("the status vocabulary (the OSC 9 states)", () => {
  it("treats both ways a process ENDS as ended", () => {
    // A crashed session is exactly as unable to produce output as an exited one,
    // so session selection must not read it as live (reloading onto a corpse was
    // the stuck-loading wedge).
    expect(isEndedStatus("exited")).toBe(true);
    expect(isEndedStatus("crashed")).toBe(true);
    for (const live of ["idle", "working", "warning", "failed", "input", "done", ""]) {
      expect(isEndedStatus(live), live).toBe(false);
    }
  });

  it("floors the dot reveal for the states that are self-evidently news", () => {
    // A plain shell that dies badly never reported activity in its life, so the
    // server's sticky reportsActivity flag is not set for it — and its red dot is
    // the only signal it ever produced. A clean exit stays gated: not news.
    expect(["warning", "failed", "crashed"].every(statusRevealsDot)).toBe(true);
    expect(["idle", "working", "input", "done", "exited", ""].some(statusRevealsDot)).toBe(false);
  });

  it("words every status once, for both the tooltip and the accessible name", () => {
    expect(statusPhrase("working")).toBe("working");
    expect(statusPhrase("warning")).toBe("warning reported");
    expect(statusPhrase("failed")).toBe("error reported");
    expect(statusPhrase("input")).toBe("waiting for you");
    expect(statusPhrase("done")).toBe("turn finished");
    expect(statusPhrase("exited")).toBe("session ended");
    expect(statusPhrase("crashed")).toBe("process crashed");
    expect(statusPhrase("idle")).toBe("idle");
    expect(statusPhrase("")).toBe("idle");
    // A newer server's unknown status is surfaced raw rather than hidden: the
    // wire is parsed, not validated.
    expect(statusPhrase("hibernating")).toBe("hibernating");
  });

  it("puts the state into a tab's accessible name", () => {
    expect(tabAccessibleName("agent", "crashed")).toBe("agent — process crashed");
    expect(tabAccessibleName("78% · agent", "working")).toBe("78% · agent — working");
  });
});

describe("the OSC 9;4 percentage", () => {
  it("reads an absent or untrustworthy value as absent, never as 0%", () => {
    // -1 is the engine's own absence marker, and absence must render NO bar
    // rather than an empty one, so it may never be normalised to 0.
    expect(normalizeProgress(-1)).toBe(PROGRESS_ABSENT);
    expect(normalizeProgress(undefined)).toBe(PROGRESS_ABSENT);
    expect(normalizeProgress(null)).toBe(PROGRESS_ABSENT);
    expect(normalizeProgress("50")).toBe(PROGRESS_ABSENT);
    expect(normalizeProgress(Number.NaN)).toBe(PROGRESS_ABSENT);
    expect(normalizeProgress(Number.POSITIVE_INFINITY)).toBe(PROGRESS_ABSENT);
    expect(normalizeProgress(-7)).toBe(PROGRESS_ABSENT);
  });

  it("keeps 0 distinct from absent, and clamps an out-of-range high value", () => {
    expect(normalizeProgress(0)).toBe(0);
    expect(normalizeProgress(100)).toBe(100);
    expect(normalizeProgress(140)).toBe(100);
    expect(normalizeProgress(37.6)).toBe(38);
  });

  it("announces a percentage in the accessible name and never as visible text", () => {
    // The number reaches a screen reader, which cannot see the 2px bar, and
    // reaches nothing that costs label width. No terminal draws it as text.
    expect(tabAccessibleName("agent", "working", 78)).toBe("agent — working, 78%");
    expect(tabAccessibleName("agent", "working", 0)).toBe("agent — working, 0%");
    // Absent, or omitted entirely, announces the state alone.
    expect(tabAccessibleName("agent", "working", PROGRESS_ABSENT)).toBe("agent — working");
    expect(tabAccessibleName("agent", "working")).toBe("agent — working");
  });

  it("shows a percentage only under a status the progress channel owns", () => {
    // The three statuses the OSC 9;4 channel itself produces.
    expect(statusOwnsProgress("working")).toBe(true);
    expect(statusOwnsProgress("failed")).toBe(true);
    expect(statusOwnsProgress("warning")).toBe(true);
    // Everything else comes from somewhere else: the notification channel
    // (done/input), the absence of a progress state (idle), or the process
    // (exited/crashed).
    for (const status of ["done", "input", "idle", "exited", "crashed", "bogus"]) {
      expect(statusOwnsProgress(status), status).toBe(false);
    }
  });

  it("clears a percentage on exactly two things, and nothing else", () => {
    // Clear 1 is the program's own OSC 9;4;0 (the value arrives as -1), so it
    // needs no status rule at all — it is simply carried through.
    expect(renderedProgress("working", PROGRESS_ABSENT)).toBe(PROGRESS_ABSENT);
    // Clear 2: the status is not one the progress channel owns. A dead process,
    // and equally a latch or a return to idle — a percentage under any of those
    // is a claim about a different channel than the reader is looking at.
    // Measured: kiro-cli parks state 4 at its context-usage percentage when
    // idle, so a finished turn painted a green done dot beside a 72% bar.
    expect(renderedProgress("exited", 100)).toBe(PROGRESS_ABSENT);
    expect(renderedProgress("crashed", 60)).toBe(PROGRESS_ABSENT);
    expect(renderedProgress("done", 72)).toBe(PROGRESS_ABSENT);
    expect(renderedProgress("input", 100)).toBe(PROGRESS_ABSENT);
    expect(renderedProgress("idle", 100)).toBe(PROGRESS_ABSENT);

    // NOTHING else clears it. 100% is not a completion signal (state 1 at 100 is
    // a state that persists), the progress channel carries no "done" at all, and
    // there is no timeout — so a program that pins a value and goes quiet keeps
    // its bar rather than having a change asserted it never made.
    expect(renderedProgress("working", 100)).toBe(100);
    expect(renderedProgress("failed", 42)).toBe(42);
    expect(renderedProgress("warning", 25)).toBe(25);
    expect(renderedProgress("working", 0)).toBe(0);
  });
});

describe("parseCueSeen accepts the cue statuses and nothing else", () => {
  it("stores a crashed acknowledgement and rejects a non-cue status", () => {
    const seen = parseCueSeen(
      JSON.stringify({ s1: "crashed", s2: "done", s3: "working", s4: "exited" }),
    );
    expect([...seen.entries()]).toEqual([
      ["s1", "crashed"],
      ["s2", "done"],
    ]);
  });
});

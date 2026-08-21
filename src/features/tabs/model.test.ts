/** Session-API error contract.
 *
 *  These pin what a caller can LEARN from a failed session call, which is the
 *  whole point of SessionAPIError: a host may refuse session creation
 *  temporarily and say so (web-terminal-kiro answers 503 + Retry-After while its
 *  tool engine installs on first boot). Flattening that into a message string
 *  made it indistinguishable from a 500 and threw away the retry hint. */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fc from "fast-check";
import type { CueStatus, TabOrderKey } from "./model.js";
import {
  MAX_PERSISTED_CUE_SEEN,
  PROGRESS_ABSENT,
  SessionAPIError,
  compareTabOrder,
  createSessionAPI,
  createTombstones,
  isCueStatus,
  isEndedStatus,
  normalizeProgress,
  orderedInsertIndex,
  parseCueSeen,
  renderedProgress,
  serializeCueSeen,
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
  // Every case below asserts through `await expect(p).rejects`, never `.catch(cb)`.
  // A callback says NOTHING when the promise RESOLVES: with the `!r.ok` guard gone
  // the call succeeds, the callback never runs, and the `it` passes having asserted
  // nothing — or on a sibling verb's assertions, when one `it` covered two verbs.
  // That is why four mutants on those guards survived a file holding eight failure
  // tests. `.rejects` fails on a resolve, which is the whole point.
  it("exposes the status so a caller can tell 503 from 500", async () => {
    stubFetch(response(503));
    const refused = createSessionAPI("/api/sessions").create();
    await expect(refused).rejects.toBeInstanceOf(SessionAPIError);
    await expect(refused).rejects.toMatchObject({ status: 503 });
  });

  it("parses Retry-After delta-seconds into milliseconds", async () => {
    stubFetch(response(503, {}, { "Retry-After": "5" }));
    await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
      retryAfterMs: 5000,
    });
  });

  it("parses an HTTP-date Retry-After and never returns a negative delay", async () => {
    const past = new Date(Date.now() - 60000).toUTCString();
    stubFetch(response(503, {}, { "Retry-After": past }));
    // A date already in the past means "retry now", not "never".
    await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
      retryAfterMs: 0,
    });
  });

  it("clamps an absurd Retry-After so a bad header cannot park the UI", async () => {
    stubFetch(response(503, {}, { "Retry-After": "99999" }));
    await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
      retryAfterMs: 60000,
    });
  });

  it("ignores a missing or unparseable Retry-After", async () => {
    for (const headers of [{}, { "Retry-After": "soon" }, { "Retry-After": "  " }]) {
      stubFetch(response(503, {}, headers));
      await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
        retryAfterMs: undefined,
      });
    }
  });

  it("surfaces the envelope's message so the host's own words reach the user", async () => {
    // The first-party Go envelope (webhttp ErrorResponse) writes `error`; this is
    // the field every server in this family actually returns, and the shape
    // web-terminal-kiro's tools-installing 503 uses.
    stubFetch(response(503, { error: "tools installing", code: "", request_id: "abc" }));
    await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
      serverMessage: "tools installing",
    });
  });

  it("also accepts a `message` field", async () => {
    stubFetch(response(503, { message: "installing" }));
    await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
      serverMessage: "installing",
    });
  });

  it("prefers `error` over `message` when both are present", async () => {
    stubFetch(response(503, { error: "from error", message: "from message" }));
    await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
      serverMessage: "from error",
    });
  });

  it("caps a server message destined for UI chrome", async () => {
    stubFetch(response(503, { message: "x".repeat(400) }));
    await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
      serverMessage: "x".repeat(120),
    });
  });

  it("tolerates a non-JSON, empty, or hostile body without losing the status", async () => {
    const bodies: unknown[] = [null, "a string", { error: 42 }, { error: "   " }, []];
    for (const body of bodies) {
      stubFetch(response(503, body));
      await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
        status: 503,
        serverMessage: undefined,
      });
    }
  });

  it("keeps the status when the body rejects on read (not JSON at all)", async () => {
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
    await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
      status: 503,
      serverMessage: undefined,
    });
  });

  it("treats a Retry-After that is not purely digits as a date, not a count", async () => {
    // The header arrives from a host this code does not control, so "5x" must not
    // be read as five seconds by a regex anchored on only one end.
    for (const value of ["5x", "x5"]) {
      stubFetch(response(503, {}, { "Retry-After": value }));
      await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
        retryAfterMs: undefined,
      });
    }
  });

  it("reads a padded delta-seconds header as a count", async () => {
    // RFC 9110 permits whitespace around a field value, and a hand-rolled server
    // can send it. Untrimmed, this falls through to the date branch and the retry
    // hint is lost.
    stubFetch(response(503, {}, { "Retry-After": " 30 " }));
    await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
      retryAfterMs: 30_000,
    });
  });

  it("applies to list as well, not only create", async () => {
    // close() carries the same contract and is pinned in both directions by
    // "rejects a refused close, and resolves a successful one" below; keeping it
    // here too would mean one `it` failing for either of two verbs.
    stubFetch(response(500));
    const refused = createSessionAPI("/api/sessions").list();
    await expect(refused).rejects.toBeInstanceOf(SessionAPIError);
    await expect(refused).rejects.toMatchObject({ status: 500 });
  });
});

/** Persisted tab arrangement.
 *
 *  These pin the two properties the restore path depends on: a stored value that
 *  cannot be trusted degrades to "no arrangement" (the server's creation order is
 *  always a valid strip) rather than to a corrupted strip, and a tab is placed by
 *  the stored arrangement regardless of the order sessions ARRIVE in — which is
 *  not stable, since the status-stream snapshot races the bootstrap's list. */
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
  it("accepts exactly the four states that want the user, and nothing else", () => {
    // The switcher's aggregate dot and the out-of-page attention surfaces are
    // "like a notification": they show only the states that ask something of the
    // user. `failed` is one of them — OSC 9;4 state 2 is a result the program
    // parked, not an ongoing phase — while `working` and `warning` are genuinely
    // ongoing, and idle and a clean exit ask nothing of anyone.
    expect(["input", "done", "crashed", "failed"].every(isCueStatus)).toBe(true);
    expect(["working", "warning", "idle", "exited", "", "DONE"].some(isCueStatus)).toBe(false);
  });
});

describe("the strip's order follows the server, not arrival", () => {
  // Wire records as a server would send them: creation order d, a, c, b, and a
  // shared order the server holds that is deliberately NEITHER creation order nor
  // id order, so a test cannot pass by accident on the wrong key.
  const born: Record<string, string> = {
    d: "2026-08-11T09:00:00Z",
    a: "2026-08-11T09:01:00Z",
    c: "2026-08-11T09:02:00Z",
    b: "2026-08-11T09:03:00Z",
  };
  const key = (id: string, order?: number): TabOrderKey =>
    order === undefined
      ? { id, createdAt: born[id] ?? "" }
      : { id, createdAt: born[id] ?? "", order };

  /** Build a strip by adopting ids in the given arrival order, the way
   *  adoptSession does: compute the index, splice the tab in. */
  const build = (arrival: readonly string[], order: Record<string, number>): string[] => {
    const strip: TabOrderKey[] = [];
    for (const id of arrival) {
      const incoming = key(id, order[id]);
      strip.splice(orderedInsertIndex(strip, incoming), 0, incoming);
    }
    return strip.map((t) => t.id);
  };

  it("rebuilds the server's arrangement from any arrival order", () => {
    // This is the whole point of server-owned order: a second device that has
    // never seen this server opens on the arrangement its owner chose.
    const server = { c: 0, a: 1, b: 2, d: 3 };
    for (const arrival of permutations(["a", "b", "c", "d"])) {
      expect(build(arrival, server), arrival.join(">")).toEqual(["c", "a", "b", "d"]);
    }
  });

  it("falls back to creation order against a server that keeps no order", () => {
    // An engine before 3.9.0 sends no order field at all. Every position is then
    // absent, age is the only key left, and creation order is the honest answer.
    for (const arrival of permutations(["a", "b", "c", "d"])) {
      expect(build(arrival, {}), arrival.join(">")).toEqual(["d", "a", "c", "b"]);
    }
  });

  it("puts a session the server has not placed after every session it has", () => {
    // The mixed case: a server that keeps an order, and one session whose event
    // carried none. Absent must not read as position 0, which would drag it to
    // the head of the strip.
    for (const arrival of permutations(["a", "b", "c", "d"])) {
      expect(build(arrival, { c: 0, b: 1 }), arrival.join(">")).toEqual(["c", "b", "d", "a"]);
    }
  });

  it("appends the first tab of an empty strip", () => {
    expect(orderedInsertIndex([], key("a", 0))).toBe(0);
    expect(orderedInsertIndex([], key("a"))).toBe(0);
  });

  it("converges on one strip from every arrival order, for any server order", () => {
    const ids = ["a", "b", "c", "d"];
    fc.assert(
      fc.property(
        fc.record({
          // A permutation of the ids is what the server's dense order is, so the
          // property covers every arrangement a reorder can produce.
          server: fc.shuffledSubarray(ids, { minLength: ids.length }),
          arrivals: fc.uniqueArray(fc.shuffledSubarray(ids, { minLength: ids.length }), {
            minLength: 2,
            maxLength: 6,
          }),
        }),
        ({ server, arrivals }) => {
          const order: Record<string, number> = {};
          server.forEach((id, i) => {
            order[id] = i;
          });
          const strips = arrivals.map((arrival) => build(arrival, order).join(">"));
          // One strip, and it is the server's arrangement.
          expect(new Set(strips).size).toBe(1);
          expect(strips[0]).toBe(server.join(">"));
        },
      ),
    );
  });
});

/** Every permutation of a small id list, so an arrival-order test states "any
 *  order" rather than a hand-picked few. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const head = items[i];
    if (head === undefined) {
      continue;
    }
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      out.push([head, ...tail]);
    }
  }
  return out;
}

describe("compareTabOrder is a total order", () => {
  const early = "2026-08-11T09:00:00Z";
  const late = "2026-08-11T09:00:01Z";
  const at = (iso: string, id: string, order?: number): TabOrderKey =>
    order === undefined ? { id, createdAt: iso } : { id, createdAt: iso, order };

  it("ranks the server's position above age and id", () => {
    // "b" is younger and sorts later by id, and still comes first because the
    // server put it there. That is the user's arrangement outranking every
    // inference about it.
    expect(compareTabOrder(at(late, "b", 0), at(early, "a", 1))).toBeLessThan(0);
    expect(compareTabOrder(at(early, "a", 1), at(late, "b", 0))).toBeGreaterThan(0);
  });

  it("orders two unplaced sessions by age", () => {
    expect(compareTabOrder(at(early, "z"), at(late, "a"))).toBeLessThan(0);
    expect(compareTabOrder(at(late, "a"), at(early, "z"))).toBeGreaterThan(0);
  });

  it("sorts an unplaced session after a placed one, whatever its age", () => {
    // Absent is not position 0. A session the server has not placed is newer than
    // the arrangement, so the end is where it belongs.
    expect(compareTabOrder(at(early, "a"), at(late, "z", 5))).toBeGreaterThan(0);
  });

  it("breaks a shared position and timestamp on id, so no pair is ever unordered", () => {
    // A shared position cannot happen while the server keeps the order dense, but
    // two sessions created inside one millisecond can, and without the id they
    // would sort by whatever order the input happened to be in. Sub-millisecond
    // precision is deliberately not read (Go's RFC 3339 fraction cannot be
    // compared as a string), so the id carries these.
    expect(compareTabOrder(at(early, "a"), at(early, "b"))).toBeLessThan(0);
    expect(compareTabOrder(at(early, "b"), at(early, "a"))).toBeGreaterThan(0);
    expect(compareTabOrder(at(early, "a"), at(early, "a"))).toBe(0);
  });

  it("sorts a session it cannot date last, not first", () => {
    // A timestamp the client cannot read must not rewrite the head of the strip.
    for (const bad of ["", "not-a-date", "2026-13-45T99:99:99Z"]) {
      expect(compareTabOrder(at(bad, "a"), at(late, "z"))).toBeGreaterThan(0);
    }
  });

  it("is antisymmetric for every pair of keys", () => {
    const keys = [
      at(early, "a"),
      at(early, "b"),
      at(late, "a"),
      at(late, "b"),
      at(early, "a", 0),
      at(late, "b", 0),
      at(early, "b", 1),
    ];
    for (const x of keys) {
      for (const y of keys) {
        const forward = compareTabOrder(x, y);
        const back = compareTabOrder(y, x);
        // Stated as a sum so the self-comparison case holds too: Math.sign(0) is
        // 0 and -Math.sign(0) is -0, which Object.is separates.
        expect(
          Math.sign(forward) + Math.sign(back),
          `${x.id}@${x.createdAt}#${String(x.order)} vs ${y.id}@${y.createdAt}#${String(y.order)}`,
        ).toBe(0);
      }
    }
  });

  it("sorts a whole strip the same way inserting one at a time does", () => {
    // applyServerOrder sorts the live list; adoptSession inserts into it. The two
    // must agree, or a remote reorder and a fresh adopt would fight.
    const strip = [at(late, "b", 2), at(early, "a", 0), at(late, "c", 1)];
    const sorted = [...strip].sort(compareTabOrder).map((k) => k.id);
    const inserted: TabOrderKey[] = [];
    for (const k of strip) {
      inserted.splice(orderedInsertIndex(inserted, k), 0, k);
    }
    expect(sorted).toEqual(inserted.map((k) => k.id));
    expect(sorted).toEqual(["a", "c", "b"]);
  });
});

describe("setOrder sends the arrangement to the server", () => {
  it("PUTs the id list to the order route", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const api = createSessionAPI("/api/sessions");
    await api.setOrder(["s2", "s1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/sessions/order");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ order: ["s2", "s1"] }));
    // A JSON body without the content type is a 415 from a strict host.
    expect(calls[0]?.init?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("throws with the status, so a caller can tell 409 from a real failure", async () => {
    // 409 is the server saying "your session set is stale", which the caller
    // answers by re-listing rather than by telling the user. Any other status is a
    // genuine failure of a reorder the user performed, so the two must be
    // distinguishable.
    for (const status of [409, 404, 500]) {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status })));
      const api = createSessionAPI("/api/sessions");
      await expect(api.setOrder(["s1"])).rejects.toMatchObject({
        name: "SessionAPIError",
        status,
      });
    }
  });
});

describe("the session API's requests", () => {
  it("asks for JSON and carries an abort timeout, so a wedged host cannot hang the strip", async () => {
    // The timeout is the only thing bounding a request to a host that accepted the
    // connection and then went quiet; without it the strip waits forever.
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("[]", { status: 200 }));
    });

    await createSessionAPI("/api/sessions").list();

    expect(calls[0]?.init?.headers).toEqual({ Accept: "application/json" });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends a pinned name as a JSON PUT under the session's escaped path", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    await createSessionAPI("/api/sessions").setPinnedTitle("a/b c", "release notes");

    expect(calls[0]?.url).toBe("/api/sessions/a%2Fb%20c/pinned-title");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ title: "release notes" }));
    expect(calls[0]?.init?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("rejects a 200 whose body is not an array", async () => {
    // A Go server marshals a nil session slice as JSON `null`, and a proxy can
    // answer 200 with an error object. Either one reaching the bootstrap's
    // `sessions.length` or the poll's `list.map` is an uncaught TypeError; as a
    // rejection, both callers' existing catch paths recover.
    stubFetch(response(200, null));
    await expect(createSessionAPI("/api/sessions").list()).rejects.toThrow();
  });

  it("propagates a failed pinned-name clear, so the caller can roll the label back", async () => {
    // Not best-effort, unlike the status writes: the user renamed something and is
    // owed the truth about whether it stuck.
    stubFetch(response(500));
    await expect(createSessionAPI("/api/sessions").clearPinnedTitle("s1")).rejects.toMatchObject({
      name: "SessionAPIError",
      status: 500,
    });
  });
  it("rejects a refused close, and resolves a successful one", async () => {
    // The pre-existing failure case for close() shared its `it` with list(), and
    // `.catch(cb)` says nothing when the promise RESOLVES — so the list half
    // supplied the assertions while close()'s own guard went unpinned in both
    // directions. A close that silently "succeeds" leaves the tab on the strip.
    stubFetch(response(404));
    const refused = createSessionAPI("/api/sessions").close("s1");
    await expect(refused).rejects.toBeInstanceOf(SessionAPIError);
    await expect(refused).rejects.toMatchObject({ status: 404 });

    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 204 })));
    await expect(createSessionAPI("/api/sessions").close("s1")).resolves.toBeUndefined();
  });

  it("resolves a successful pinned-name clear", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 204 })));

    await expect(createSessionAPI("/api/sessions").clearPinnedTitle("s1")).resolves.toBeUndefined();
  });

  it("trims the server's own padding out of the message it hands to the UI", async () => {
    // The string goes straight into chrome, and a host that pads its JSON field
    // would otherwise push the visible text off its own baseline.
    stubFetch(response(503, { error: "  tools installing\n" }));
    await expect(createSessionAPI("/api/sessions").create()).rejects.toMatchObject({
      serverMessage: "tools installing",
    });
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

/** Close tombstones. The failure they exist to prevent is a tab the user just
 *  closed flashing back into the strip, because a listing that predates the
 *  server reaping the session (the SSE re-open snapshot, or the poll) still
 *  carries it. Nothing exercised this before, so every rule below — the window,
 *  its far edge, and the sweep's blast radius — was load-bearing and unpinned. */
describe("close tombstones keep a closed tab from flashing back", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a session the user just closed as tombstoned", () => {
    const tombs = createTombstones(15_000);
    tombs.add("sess-1");
    expect(tombs.active("sess-1")).toBe(true);
  });

  it("reports a session it never saw as free to adopt", () => {
    // A false positive here is worse than a flash-back: it would swallow a tab
    // the server legitimately lists and the user never closed.
    const tombs = createTombstones(15_000);
    tombs.add("sess-1");
    expect(tombs.active("sess-2")).toBe(false);
  });

  it("stops tombstoning at exactly the end of the window, not after it", () => {
    // The far edge is the whole contract: past it the server has had its chance
    // to reap, so a listing that still carries the id is authoritative and the
    // adopt must proceed.
    const tombs = createTombstones(15_000);
    tombs.add("sess-1");
    vi.advanceTimersByTime(14_999);
    expect(tombs.active("sess-1")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tombs.active("sess-1")).toBe(false);
  });

  it("does not let a second close sweep away the first tab's live tombstone", () => {
    // add() sweeps elapsed entries so the map cannot grow over a long session of
    // opens and closes. A sweep that took live entries with it would re-adopt the
    // tab closed a moment ago, which is the bug the tombstones exist to stop.
    const tombs = createTombstones(15_000);
    tombs.add("sess-1");
    vi.advanceTimersByTime(1000);
    tombs.add("sess-2");
    expect(tombs.active("sess-1")).toBe(true);
  });
});

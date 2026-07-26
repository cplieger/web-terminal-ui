/** Session-API error contract.
 *
 *  These pin what a caller can LEARN from a failed session call, which is the
 *  whole point of SessionAPIError: a host may refuse session creation
 *  temporarily and say so (web-terminal-kiro answers 503 + Retry-After while its
 *  tool engine installs on first boot). Flattening that into a message string
 *  made it indistinguishable from a 500 and threw away the retry hint. */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  MAX_PERSISTED_TAB_ORDER,
  SessionAPIError,
  createSessionAPI,
  orderedInsertIndex,
  parseTabOrder,
  serializeTabOrder,
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

// tabs/notify.ts tests: the OSC 9 Form B notification policy. Every capability
// is injected (NotifierEnv), so the suppression rule, the dedupe, the
// gesture-gated permission request and the degradation paths are exercised
// without a real browser permission model.
//
// Two of these are SECURITY tests and were red-checked against a deliberately
// mutated notify.ts (see the comments on each): the untrusted-text test fails if
// the message is ever written into the DOM, and the suppression test fails if the
// page-visibility half of the rule is dropped.

import { describe, it, expect, vi } from "vitest";
import { browserNotifierEnv, createNotifier, shouldNotify } from "./notify.js";
import type { NotificationCtorLike, NotifierEnv } from "./notify.js";

/** A recording Notification stand-in: captures what the notifier constructed and
 *  the instances themselves, so a test can drive the click the way a browser
 *  would and observe whether the notification was closed. */
function fakeCtor(): {
  ctor: NotificationCtorLike;
  posts: { title: string; body: string | undefined; tag: string | undefined }[];
  made: { onclick: ((event: Event) => void) | null; closed: boolean }[];
} {
  const posts: { title: string; body: string | undefined; tag: string | undefined }[] = [];
  const made: { onclick: ((event: Event) => void) | null; closed: boolean }[] = [];
  class Fake {
    onclick: ((event: Event) => void) | null = null;
    closed = false;
    constructor(title: string, options?: { body?: string; tag?: string }) {
      posts.push({ title, body: options?.body, tag: options?.tag });
      made.push(this);
    }
    close(): void {
      this.closed = true;
    }
  }
  return { ctor: Fake as unknown as NotificationCtorLike, posts, made };
}

function env(over: Partial<NotifierEnv> = {}): NotifierEnv {
  return {
    ctor: undefined,
    permission: () => "granted",
    request: () => undefined,
    pageVisible: () => true,
    ...over,
  };
}

/** The per-delivery view. `activate` defaults to a no-op so a test that is not
 *  about the click does not have to say anything about it; the click tests pass a
 *  spy. */
function view(
  over: Partial<{ sessionIsActive: boolean; label: string; activate: () => void }> = {},
): { sessionIsActive: boolean; label: string; activate: () => void } {
  return { sessionIsActive: false, label: "a", activate: () => undefined, ...over };
}

describe("shouldNotify (the suppression rule)", () => {
  // RED-CHECKED: with the pageVisible half deleted (`return !sessionIsActive`)
  // the "hidden page" cases below fail — a notification for the session the user
  // left running in a backgrounded tab would be silently swallowed, which is the
  // regression this pins.
  it("skips ONLY when the originating session is active AND the page is visible", () => {
    expect(shouldNotify(true, true)).toBe(false);
  });

  it("fires when the page is hidden, even for the ACTIVE session", () => {
    // The most-likely-to-regress direction: a locked phone or a backgrounded
    // browser tab is exactly when the user cannot see the terminal, so the active
    // session's notification must still be posted.
    expect(shouldNotify(true, false)).toBe(true);
  });

  it("fires for a background session whether or not the page is visible", () => {
    expect(shouldNotify(false, true)).toBe(true);
    expect(shouldNotify(false, false)).toBe(true);
  });
});

describe("createNotifier delivery", () => {
  it("posts the tab label as the title and the message as the body", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    expect(
      n.deliver(
        { id: "s1", notification: "Response complete", notificationSeq: 1 },
        view({ label: "agent" }),
      ),
    ).toBe(true);
    expect(posts).toEqual([{ title: "agent", body: "Response complete", tag: "s1" }]);
  });

  it("suppresses the active session's notification while the page is visible", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor, pageVisible: () => true }));
    expect(
      n.deliver(
        { id: "s1", notification: "Response complete", notificationSeq: 1 },
        view({ sessionIsActive: true, label: "agent" }),
      ),
    ).toBe(false);
    expect(posts).toEqual([]);
  });

  it("posts the ACTIVE session's notification when the page is hidden", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor, pageVisible: () => false }));
    expect(
      n.deliver(
        { id: "s1", notification: "Permission required", notificationSeq: 1 },
        view({ sessionIsActive: true, label: "agent" }),
      ),
    ).toBe(true);
    expect(posts).toHaveLength(1);
  });

  it("treats the untrusted message as TEXT: nothing is parsed as HTML", () => {
    // RED-CHECKED: with `document.body.innerHTML += text` added to deliver(), the
    // DOM assertions below fail (an <img> node materialises and the injected
    // onerror attribute is live). The message is untrusted program output, so the
    // invariant is that it reaches the browser's own notification surface as a
    // DATA string and never enters this document.
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    const hostile = `<img src=x onerror="globalThis.__pwned = true"><script>alert(1)</script>`;
    document.body.replaceChildren();

    expect(
      n.deliver(
        { id: "s1", notification: hostile, notificationSeq: 1 },
        view({ label: "<b>agent</b>" }),
      ),
    ).toBe(true);

    // Verbatim, unescaped, unparsed: the browser renders it as text.
    expect(posts[0]?.body).toBe(hostile);
    expect(posts[0]?.title).toBe("<b>agent</b>");
    // And no markup materialised anywhere in the document. Scoped to body for the
    // element queries because the test page has <script> tags of its own, which a
    // document-wide querySelector finds and which have nothing to do with this
    // payload; the whole-document check is on the payload's own text instead, which
    // is stricter than either query — it would catch the string landing in <head>.
    expect(document.body.querySelector("img")).toBeNull();
    expect(document.body.querySelector("script")).toBeNull();
    expect(document.body.innerHTML).toBe("");
    expect(document.documentElement.innerHTML).not.toContain("globalThis.__pwned");
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("ignores an event with no notification, and an empty one", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    expect(n.deliver({ id: "s1" }, view({ label: "a" }))).toBe(false);
    expect(n.deliver({ id: "s1", notification: "" }, view({ label: "a" }))).toBe(false);
    expect(posts).toEqual([]);
  });

  it("delivers each sequence once, and a repeated message at a NEW sequence again", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    const v = view({ label: "a" });
    expect(n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, v)).toBe(true);
    // Same event re-delivered (a doubled frame): not notified twice.
    expect(n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, v)).toBe(false);
    // The same TEXT at a new sequence is a new event.
    expect(n.deliver({ id: "s1", notification: "Done", notificationSeq: 2 }, v)).toBe(true);
    // Per session: another session's seq 1 is untouched by s1's cursor.
    expect(n.deliver({ id: "s2", notification: "Done", notificationSeq: 1 }, v)).toBe(true);
    expect(posts).toHaveLength(3);
  });

  it("delivers an event that carries no sequence number at all", () => {
    // An older server, or a notification path that does not sequence: seq 0 is
    // "unsequenced", not "sequence zero". Treating it as a number to compare
    // against the cursor would swallow every notification such a server sends.
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor }));

    expect(n.deliver({ id: "s1", notification: "Done" }, view({ label: "a" }))).toBe(true);
    expect(posts).toHaveLength(1);
  });

  it("forgets the oldest cursors once too many sessions are tracked", () => {
    // The bound exists because a hostile or buggy stream could otherwise grow the
    // dedupe map without end. What it costs is real and worth stating: the oldest
    // session's cursor is gone, so a replayed notification for THAT session can
    // notify a second time — which is why the bound is far above any real page's
    // session count rather than a tidy number.
    const { ctor } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    const v = view({ label: "a" });
    for (let i = 0; i <= 200; i++) {
      n.deliver({ id: `s${String(i)}`, notification: "Done", notificationSeq: 1 }, v);
    }

    // The next-oldest is still tracked: the sweep stops at the bound rather than
    // trimming past it. Checked first, because a suppressed delivery records
    // nothing while an accepted one would evict in its turn.
    expect(n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, v)).toBe(false);
    // The oldest is out, so its cursor no longer suppresses anything.
    expect(n.deliver({ id: "s0", notification: "Done", notificationSeq: 1 }, v)).toBe(true);
  });

  it("forgets a closed session's sequence cursor", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    const v = view({ label: "a" });
    n.deliver({ id: "s1", notification: "Done", notificationSeq: 5 }, v);
    n.forget("s1");
    // A recreated session id starts fresh rather than being muted up to seq 5.
    expect(n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, v)).toBe(true);
    expect(posts).toHaveLength(2);
  });

  it("degrades to tab-only when permission is denied, without throwing", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor, permission: () => "denied" }));
    expect(() =>
      n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, view({ label: "a" })),
    ).not.toThrow();
    expect(posts).toEqual([]);
  });

  it("degrades to tab-only when the API does not exist (iOS Safari)", () => {
    const n = createNotifier(env({ ctor: undefined }));
    expect(
      n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, view({ label: "a" })),
    ).toBe(false);
  });

  it("degrades to tab-only when the constructor throws (Safari outside a PWA)", () => {
    const throwing = class {
      constructor() {
        throw new TypeError("Illegal constructor");
      }
    } as unknown as NotificationCtorLike;
    const n = createNotifier(env({ ctor: throwing }));
    expect(
      n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, view({ label: "a" })),
    ).toBe(false);
  });
});

// Clicking a notification has to land the user on the session that raised it.
// The Notifications API's own click default already moves focus to the viewport
// of the notification's browsing context, so the page comes forward without our
// help; the half that was missing is the in-page switch, which left the user
// looking at whichever tab they last had active.
describe("createNotifier click activation", () => {
  it("activates the notification's own session when clicked", () => {
    // RED-CHECKED against a notify.ts with the onclick assignment removed: the
    // activation never fires, which is exactly the reported behaviour (the page
    // is focused by the platform, the wrong tab is showing).
    const { ctor, made } = fakeCtor();
    const activate = vi.fn();
    const n = createNotifier(env({ ctor }));
    expect(
      n.deliver(
        { id: "s1", notification: "Permission required", notificationSeq: 1 },
        view({ activate }),
      ),
    ).toBe(true);

    expect(made).toHaveLength(1);
    expect(activate).not.toHaveBeenCalled(); // not until the user clicks
    made[0]?.onclick?.(new Event("click"));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("closes the notification it just acted on", () => {
    // It is no longer relevant once the user has acted on it. (Closing is only
    // wrong as a display timer, which strips it from the tray before the user
    // can interact at all.)
    const { ctor, made } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, view());
    expect(made[0]?.closed).toBe(false);
    made[0]?.onclick?.(new Event("click"));
    expect(made[0]?.closed).toBe(true);
  });

  it("does not cancel the platform's own focus default", () => {
    // The handler must NOT preventDefault(): that default is what brings the page
    // forward, and cancelling it would leave the switch happening in a window the
    // user cannot see. Nor does it call window.focus() — the platform already did.
    const { ctor, made } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, view());
    const event = new Event("click", { cancelable: true });
    made[0]?.onclick?.(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("gives each session's notification its own activation", () => {
    // The click closure carries the session, so two live notifications cannot
    // activate each other's tab.
    const { ctor, made } = fakeCtor();
    const first = vi.fn();
    const second = vi.fn();
    const n = createNotifier(env({ ctor }));
    n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, view({ activate: first }));
    n.deliver({ id: "s2", notification: "Done", notificationSeq: 1 }, view({ activate: second }));

    made[1]?.onclick?.(new Event("click"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("createNotifier permission request", () => {
  it("asks on a gesture, once, and only for an armed page with an undecided permission", () => {
    const request = vi.fn();
    const { ctor } = fakeCtor();
    const n = createNotifier(env({ ctor, permission: () => "default", request }));

    // Not armed yet: a plain shell's user is never prompted.
    n.gesture();
    expect(request).not.toHaveBeenCalled();

    // A session reported activity -> its program speaks OSC 9 -> worth asking.
    n.arm();
    n.gesture();
    expect(request).toHaveBeenCalledTimes(1);

    // Once per page, whatever the answer: no re-prompt storm on every press.
    n.gesture();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not ask when permission is already decided, or the API is absent", () => {
    const granted = vi.fn();
    const { ctor } = fakeCtor();
    const a = createNotifier(env({ ctor, permission: () => "granted", request: granted }));
    a.arm();
    a.gesture();
    expect(granted).not.toHaveBeenCalled();

    const denied = vi.fn();
    const b = createNotifier(env({ ctor, permission: () => "denied", request: denied }));
    b.arm();
    b.gesture();
    expect(denied).not.toHaveBeenCalled();

    const absent = vi.fn();
    const c = createNotifier(
      env({ ctor: undefined, permission: () => "default", request: absent }),
    );
    c.arm();
    c.gesture();
    expect(absent).not.toHaveBeenCalled();
  });

  it("survives a browser that throws from requestPermission", () => {
    const { ctor } = fakeCtor();
    const n = createNotifier(
      env({
        ctor,
        permission: () => "default",
        request: () => {
          throw new Error("nope");
        },
      }),
    );
    n.arm();
    expect(() => {
      n.gesture();
    }).not.toThrow();
  });
});

// browserNotifierEnv is the only place in the feature that touches globals, and
// its whole job is to answer safely about a `Notification` that may be absent —
// or present and not callable, which is what an embedding page that defines its
// own `Notification` symbol looks like. Every reading goes through a
// `typeof value === "function"` test for that reason: a non-callable global must
// read exactly like an absent one, because the alternative is `new
// Notification(...)` on an object, i.e. a TypeError on the notification path.
describe("browserNotifierEnv (the real-globals adapter)", () => {
  it("reports no constructor and a denied permission where Notification is absent", () => {
    vi.stubGlobal("Notification", undefined);
    const env = browserNotifierEnv();
    expect(env.ctor).toBeUndefined();
    // "denied" rather than "default": nothing may be posted, and nothing may be
    // requested either, since there is no API to request from.
    expect(env.permission()).toBe("denied");
    expect(() => {
      env.request();
    }).not.toThrow();
  });

  it("reads the permission and the constructor off a callable Notification", () => {
    const ctor = function Fake(): void {
      /* a browser's Notification is a constructor */
    };
    vi.stubGlobal("Notification", Object.assign(ctor, { permission: "granted" }));
    const env = browserNotifierEnv();
    expect(env.ctor).toBe(ctor);
    expect(env.permission()).toBe("granted");
  });

  it("treats a NON-CALLABLE Notification global as absent, not as an API", () => {
    // A host page with its own `window.Notification` object (a shim, a polyfill
    // stub, an analytics namespace). Reading its `permission` would let the
    // notifier believe it may post, and handing it back as `ctor` would make the
    // post itself throw.
    const request = vi.fn();
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: request });
    const env = browserNotifierEnv();
    expect(env.ctor).toBeUndefined();
    expect(env.permission()).toBe("denied");
    env.request();
    expect(request).not.toHaveBeenCalled();
  });

  it("requests permission through either supported requestPermission shape", () => {
    // Modern browsers return a promise, older Safari takes a callback and returns
    // undefined. Neither result is awaited — the answer is read from permission()
    // at the next notification — so both shapes are simply called.
    const promiseShape = vi.fn(() => Promise.resolve("granted"));
    const ctorA = Object.assign(
      function FakeA(): void {
        /* constructor */
      },
      { permission: "default", requestPermission: promiseShape },
    );
    vi.stubGlobal("Notification", ctorA);
    browserNotifierEnv().request();
    expect(promiseShape).toHaveBeenCalledTimes(1);
    // Called as a method of Notification, the way both shapes expect.
    expect(promiseShape.mock.instances[0]).toBe(ctorA);

    const callbackShape = vi.fn((): undefined => undefined);
    vi.stubGlobal(
      "Notification",
      Object.assign(
        function FakeB(): void {
          /* constructor */
        },
        { permission: "default", requestPermission: callbackShape },
      ),
    );
    browserNotifierEnv().request();
    expect(callbackShape).toHaveBeenCalledTimes(1);
  });

  it("does not attempt a request on a Notification that has no requestPermission", () => {
    // iOS Safari's history: the constructor has existed there without the
    // permission API. Calling a non-function would throw on the gesture path,
    // which runs inside a click handler.
    vi.stubGlobal(
      "Notification",
      Object.assign(
        function Fake(): void {
          /* constructor */
        },
        { permission: "default" },
      ),
    );
    const env = browserNotifierEnv();
    expect(() => {
      env.request();
    }).not.toThrow();
    expect(env.permission()).toBe("default");
  });

  it("reports a non-string permission as denied", () => {
    vi.stubGlobal(
      "Notification",
      Object.assign(
        function Fake(): void {
          /* constructor */
        },
        { permission: 1 },
      ),
    );
    expect(browserNotifierEnv().permission()).toBe("denied");
  });

  it("reads page visibility from document.visibilityState", () => {
    const env = browserNotifierEnv();
    expect(env.pageVisible()).toBe(true);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    expect(env.pageVisible()).toBe(false);
    hidden.mockRestore();
  });
});

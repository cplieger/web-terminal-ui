// @vitest-environment happy-dom
//
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
import { createNotifier, shouldNotify } from "./notify.js";
import type { NotificationCtorLike, NotifierEnv } from "./notify.js";

/** A recording Notification stand-in: captures what the notifier constructed,
 *  which is the whole observable surface of a posted notification. */
function fakeCtor(): {
  ctor: NotificationCtorLike;
  posts: { title: string; body: string | undefined; tag: string | undefined }[];
} {
  const posts: { title: string; body: string | undefined; tag: string | undefined }[] = [];
  class Fake {
    constructor(title: string, options?: { body?: string; tag?: string }) {
      posts.push({ title, body: options?.body, tag: options?.tag });
    }
  }
  return { ctor: Fake as unknown as NotificationCtorLike, posts };
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
        { sessionIsActive: false, label: "agent" },
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
        { sessionIsActive: true, label: "agent" },
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
        { sessionIsActive: true, label: "agent" },
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
        { sessionIsActive: false, label: "<b>agent</b>" },
      ),
    ).toBe(true);

    // Verbatim, unescaped, unparsed: the browser renders it as text.
    expect(posts[0]?.body).toBe(hostile);
    expect(posts[0]?.title).toBe("<b>agent</b>");
    // And no markup materialised anywhere in the document.
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(document.body.innerHTML).toBe("");
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("ignores an event with no notification, and an empty one", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    expect(n.deliver({ id: "s1" }, { sessionIsActive: false, label: "a" })).toBe(false);
    expect(n.deliver({ id: "s1", notification: "" }, { sessionIsActive: false, label: "a" })).toBe(
      false,
    );
    expect(posts).toEqual([]);
  });

  it("delivers each sequence once, and a repeated message at a NEW sequence again", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    const view = { sessionIsActive: false, label: "a" };
    expect(n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, view)).toBe(true);
    // Same event re-delivered (a doubled frame): not notified twice.
    expect(n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, view)).toBe(false);
    // The same TEXT at a new sequence is a new event.
    expect(n.deliver({ id: "s1", notification: "Done", notificationSeq: 2 }, view)).toBe(true);
    // Per session: another session's seq 1 is untouched by s1's cursor.
    expect(n.deliver({ id: "s2", notification: "Done", notificationSeq: 1 }, view)).toBe(true);
    expect(posts).toHaveLength(3);
  });

  it("forgets a closed session's sequence cursor", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor }));
    const view = { sessionIsActive: false, label: "a" };
    n.deliver({ id: "s1", notification: "Done", notificationSeq: 5 }, view);
    n.forget("s1");
    // A recreated session id starts fresh rather than being muted up to seq 5.
    expect(n.deliver({ id: "s1", notification: "Done", notificationSeq: 1 }, view)).toBe(true);
    expect(posts).toHaveLength(2);
  });

  it("degrades to tab-only when permission is denied, without throwing", () => {
    const { ctor, posts } = fakeCtor();
    const n = createNotifier(env({ ctor, permission: () => "denied" }));
    expect(() =>
      n.deliver(
        { id: "s1", notification: "Done", notificationSeq: 1 },
        { sessionIsActive: false, label: "a" },
      ),
    ).not.toThrow();
    expect(posts).toEqual([]);
  });

  it("degrades to tab-only when the API does not exist (iOS Safari)", () => {
    const n = createNotifier(env({ ctor: undefined }));
    expect(
      n.deliver(
        { id: "s1", notification: "Done", notificationSeq: 1 },
        { sessionIsActive: false, label: "a" },
      ),
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
      n.deliver(
        { id: "s1", notification: "Done", notificationSeq: 1 },
        { sessionIsActive: false, label: "a" },
      ),
    ).toBe(false);
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

// The non-persistent `Notification` constructor is the one notification surface
// a page without a service worker has. browserNotifierEnv() is the one place
// that reads globals; everything else takes a NotifierEnv.

import type { Notifier } from "./types.js";

interface NotificationLike {
  onclick: ((event: Event) => void) | null;
  close: () => void;
}

/** The slice of `window.Notification` used here. */
export type NotificationCtorLike = new (
  title: string,
  options?: { body?: string; tag?: string },
) => NotificationLike;

/** The capabilities a notifier needs. `permission` is a plain string rather than
 *  the DOM's union: a browser may report a value this code does not know, and an
 *  unknown value must degrade rather than be asserted. */
export interface NotifierEnv {
  /** The Notification constructor, or undefined where the API does not exist
   *  (iOS Safari outside an installed PWA, a non-secure context). */
  ctor: NotificationCtorLike | undefined;
  /** Current permission: "default" | "granted" | "denied" (or anything else). */
  permission: () => string;
  /** Ask for permission. Must be called from a user gesture. */
  request: () => void;
  /** Is the page currently visible to the user? */
  pageVisible: () => boolean;
}

/** The suppression rule: skip ONLY when the user is already looking at the
 *  terminal that produced the notification. A hidden page (another browser tab, a
 *  locked phone) notifies even for the active session; keying on the active tab
 *  alone would swallow the notification of the session the user left running. */
export function shouldNotify(sessionIsActive: boolean, pageVisible: boolean): boolean {
  return !(sessionIsActive && pageVisible);
}

/** Bound on each per-session map: each key is a live session server-side, so a
 *  real page is nowhere near this and a hostile stream cannot grow it. */
const MAX_TRACKED_SESSIONS = 200;

export function createNotifier(env: NotifierEnv): Notifier {
  // Highest sequence delivered per session. The engine never replays a
  // notification; this makes a doubled frame unable to notify twice for one event.
  const lastSeq = new Map<string, number>();
  // The banner on screen per session. A page notification is invisible to
  // ServiceWorkerRegistration.getNotifications(), so only this reference can
  // close it once its session is read.
  const shown = new Map<string, NotificationLike>();
  let armed = false;
  let requested = false;

  // `drop` must remove the key, or this never ends.
  function evict(map: Map<string, unknown>, drop: (id: string) => void): void {
    while (map.size > MAX_TRACKED_SESSIONS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      drop(oldest);
    }
  }
  function retract(id: string): void {
    const posted = shown.get(id);
    if (posted === undefined) {
      return;
    }
    shown.delete(id);
    try {
      posted.close();
    } catch {
      /* a banner the platform already took down */
    }
  }

  return {
    deliver(ev, view): boolean {
      const text = ev.notification ?? "";
      if (text === "") {
        return false;
      }
      const seq = ev.notificationSeq ?? 0;
      if (seq !== 0) {
        if (seq <= (lastSeq.get(ev.id) ?? 0)) {
          return false;
        }
        lastSeq.set(ev.id, seq);
        evict(lastSeq, (id) => lastSeq.delete(id));
      }
      if (!shouldNotify(view.sessionIsActive, env.pageVisible())) {
        return false;
      }
      const Ctor = env.ctor;
      if (!Ctor || env.permission() !== "granted") {
        return false;
      }
      try {
        // The message is untrusted program output: it is a DATA string to the
        // Notification API and never enters this document.
        const posted = new Ctor(view.label, { body: text, tag: ev.id });
        // The click's own default already focuses the page, so no preventDefault
        // and no window.focus(). Not the `navigate` option: it reloads the page,
        // dropping every socket to land where the page already is.
        posted.onclick = (): void => {
          view.activate();
          posted.close();
          if (shown.get(ev.id) === posted) {
            shown.delete(ev.id);
          }
        };
        // Re-inserted so map order is banner age, and the banner evicted is
        // closed: a dropped reference would leave it (and Android's launcher
        // dot) up with nothing able to retract it.
        shown.delete(ev.id);
        shown.set(ev.id, posted);
        evict(shown, retract);
        return true;
      } catch {
        // Safari throws on `new Notification` outside an installed PWA.
        return false;
      }
    },
    arm(): void {
      armed = true;
    },
    gesture(): void {
      // Safari rejects and Chrome penalises a prompt with no gesture behind it.
      // Gated on `armed` so a plain shell, which emits no OSC 9, never prompts.
      if (!armed || requested) {
        return;
      }
      const Ctor = env.ctor;
      if (!Ctor || env.permission() !== "default") {
        return;
      }
      requested = true;
      try {
        env.request();
      } catch {
        /* a browser that refuses to be asked is a tab-only browser */
      }
    },
    retract,
    forget(id): void {
      lastSeq.delete(id);
      retract(id);
    },
  };
}

/** Bind a notifier to `doc`'s browser realm. `Notification` is read through
 *  `unknown` because it is absent on iOS Safari and in test DOMs, and a
 *  non-callable value (a host page's shim) reads as absent. Both
 *  `requestPermission` shapes are tolerated, since the result is not awaited: the
 *  answer is read from `permission()` at the next notification. */
export function browserNotifierEnv(doc: Document): NotifierEnv {
  const ctor = (): unknown => (doc.defaultView as { Notification?: unknown } | null)?.Notification;
  const api = (): { permission?: unknown; requestPermission?: unknown } | undefined => {
    const value = ctor();
    return typeof value === "function"
      ? (value as unknown as { permission?: unknown; requestPermission?: unknown })
      : undefined;
  };
  return {
    get ctor(): NotificationCtorLike | undefined {
      const value = ctor();
      return typeof value === "function" ? (value as NotificationCtorLike) : undefined;
    },
    permission: (): string => {
      const value = api()?.permission;
      return typeof value === "string" ? value : "denied";
    },
    request: (): void => {
      const fn = api()?.requestPermission;
      if (typeof fn === "function") {
        (fn as () => unknown).call(api());
      }
    },
    // Not document.hasFocus(): that is false for a visible-but-unfocused window,
    // where the terminal IS on screen.
    pageVisible: (): boolean => doc.visibilityState !== "hidden",
  };
}

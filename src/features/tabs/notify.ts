// tabs/notify.ts — OSC 9 Form B notifications (`OSC 9 ; <message> ST`) as
// BROWSER notifications. The spec names the display mode ("post a
// notification"), which is why this one signal is not tab-only chrome: a
// finished turn or a permission prompt has to be able to reach a user who is
// looking at another app. Clicking one takes the user to the session that raised
// it (see deliver).
//
// NON-PERSISTENT notifications (the `new Notification()` constructor), which is
// the standard surface available to a page with no service worker. Their lifetime
// is tied to the page's, which suits this app exactly: the notification is about
// a live PTY the page is attached to, and there is nothing useful to click once
// the page is gone. Per the Notifications API the constructor throws on most
// mobile browsers, where persistent (service-worker) notifications are the only
// route; that throw is caught below and degrades to tab-only chrome. Registering
// a service worker for an app that is otherwise entirely live is a cost this does
// not pay — mobile support for the standard constructor is the platforms' side of
// the contract.
//
// A notification is an EVENT, not a state (that is the structural difference
// from OSC 9;4 progress, which is a state and drives the status dot): the engine
// latches nothing for it and never replays it, so it is delivered once, on the
// sweep that first observes it.
//
// DOM-free and global-free by construction: every capability comes in through
// NotifierEnv, so the decisions here are unit-testable without a browser
// permission model, and the one place that touches globals is
// browserNotifierEnv() below. The notification text NEVER enters the DOM — see
// the note on deliver().

/** The slice of a non-persistent `Notification` instance this feature uses: the
 *  `click` handler and `close()`. The instance is no longer discarded — attaching
 *  a click handler is what lets a notification finish its job (see deliver).
 *  Module-private: it is the ctor type's return shape, not a consumer surface. */
interface NotificationLike {
  onclick: ((event: Event) => void) | null;
  close: () => void;
}

/** The slice of `window.Notification` used here. */
export type NotificationCtorLike = new (
  title: string,
  options?: { body?: string; tag?: string },
) => NotificationLike;

/** The capabilities a notifier needs, all injected. `permission` and `request`
 *  are read as plain strings rather than the DOM's NotificationPermission union:
 *  they come from a browser that may report something newer, and a value we do
 *  not recognise must degrade rather than be asserted. */
export interface NotifierEnv {
  /** The Notification constructor, or undefined where the API does not exist
   *  (iOS Safari outside an installed PWA, a non-secure context, happy-dom). */
  ctor: NotificationCtorLike | undefined;
  /** Current permission: "default" | "granted" | "denied" (or anything else). */
  permission: () => string;
  /** Ask for permission. Must be called from a user gesture. */
  request: () => void;
  /** Is the page currently visible to the user? */
  pageVisible: () => boolean;
}

/** One status event's notification payload (the fields SessionStatus carries for
 *  it). Both are optional: an older server, or any event that carries no
 *  notification, simply omits them. */
interface NotificationEvent {
  readonly id: string;
  readonly notification?: string | undefined;
  readonly notificationSeq?: number | undefined;
}

/** shouldNotify is the suppression rule, alone and testable.
 *
 *  Skip a notification ONLY when the user is already looking at the terminal that
 *  produced it: its tab is the active one AND the page is visible. Both halves
 *  are required, and the second is the one that matters most — when the page is
 *  HIDDEN (another browser tab, a locked phone, a minimised window) the
 *  notification fires even for the active session, because that is exactly the
 *  situation where the user cannot see the terminal at all. A rule that keyed
 *  only on "is this the active tab" would silently swallow the notification of
 *  the very session the user left running. */
export function shouldNotify(sessionIsActive: boolean, pageVisible: boolean): boolean {
  return !(sessionIsActive && pageVisible);
}

/** Bound on the per-session dedupe map, same reasoning as the model's other
 *  bounded stores: each key is a live session server-side, so a real one is
 *  nowhere near this, and a hostile or buggy stream cannot grow it without end. */
const MAX_TRACKED_SESSIONS = 200;

export interface Notifier {
  /** Deliver one status event's notification, if it carries a new one. Returns
   *  true when a browser notification was actually posted (false covers every
   *  degraded path: no notification in the event, a repeat, suppression, no API,
   *  no permission, a throwing constructor).
   *
   *  `view.activate` is what the notification's click performs in the page. The
   *  caller supplies it, so this module still knows nothing about sessions, tabs
   *  or the DOM. */
  deliver(
    ev: NotificationEvent,
    view: { sessionIsActive: boolean; label: string; activate: () => void },
  ): boolean;
  /** Note that this page has a session capable of notifying, which is what makes
   *  a permission prompt worth raising at all. */
  arm(): void;
  /** Note a user gesture: the ONLY moment a permission prompt may be raised. */
  gesture(): void;
  /** Drop a closed session's dedupe state. */
  forget(id: string): void;
}

export function createNotifier(env: NotifierEnv): Notifier {
  // Highest notification sequence delivered per session. The engine never
  // replays a notification, so this is a belt-and-braces guard rather than the
  // mechanism that makes re-delivery safe: it costs one map and it means a
  // duplicated frame (a doubled subscriber, a consumer re-emitting a snapshot)
  // cannot notify twice for one event.
  const lastSeq = new Map<string, number>();
  let armed = false;
  let requested = false;

  function evict(): void {
    while (lastSeq.size > MAX_TRACKED_SESSIONS) {
      const oldest = lastSeq.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      lastSeq.delete(oldest);
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
          return false; // already delivered this event
        }
        lastSeq.set(ev.id, seq);
        evict();
      }
      if (!shouldNotify(view.sessionIsActive, env.pageVisible())) {
        return false;
      }
      const Ctor = env.ctor;
      if (!Ctor || env.permission() !== "granted") {
        // Degrade silently to tab-only: the session's dot and the switcher's
        // aggregate cue already carry that something happened. No throw, no
        // console noise — an unpermitted notification is a normal state of the
        // world, not an error.
        return false;
      }
      try {
        // The message is UNTRUSTED program output. It is passed as DATA to the
        // Notification API (a string option, rendered by the browser's own
        // notification surface) and is never written into the DOM — not as
        // innerHTML, not as a template string that becomes markup, not into a
        // label. The engine already strips control/bidi runes and clamps the
        // length; that is not widened here. If this ever needs an in-page
        // surface, it must use textContent.
        const posted = new Ctor(view.label, { body: text, tag: ev.id });
        // A notification the user clicks should land them on the terminal that
        // raised it. Half of that is the click event's OWN default behaviour —
        // per the Notifications API, activating a non-persistent notification
        // moves focus to the viewport of its browsing context — so this handler
        // deliberately does NOT preventDefault() and does NOT call
        // window.focus(): the platform already brings the page forward, and the
        // only missing half is switching to the right session inside it. That
        // asymmetry is the whole bug this fixes: the page came forward and then
        // showed whichever tab the user happened to leave active.
        //
        // NOT the `navigate` option, which is the declarative alternative and
        // bypasses the click event entirely: it NAVIGATES, which for a live
        // terminal means dropping every WebSocket and replaying scrollback to
        // arrive somewhere the page already was. A same-page switch is both
        // cheaper and correct. Do not "modernise" this into `navigate`.
        posted.onclick = (): void => {
          view.activate();
          // The user has just acted on it, so it is no longer relevant — the
          // documented reason to close one. (Closing is only wrong when used as
          // a display timer, which also strips it from the notification tray
          // before the user can interact.)
          posted.close();
        };
        return true;
      } catch {
        // Safari throws on `new Notification` outside an installed PWA even when
        // the constructor exists. Tab-only, silently.
        return false;
      }
    },
    arm(): void {
      armed = true;
    },
    gesture(): void {
      // Permission is requested from a USER GESTURE, never at load: Safari
      // rejects (and Chrome penalises) a prompt with no gesture behind it, and a
      // prompt on page load is the pattern browsers added those rules for.
      //
      // Gated on `armed` as well, so only a page that actually has a
      // notification-capable session ever prompts: a plain shell emits no OSC 9,
      // and asking its user for notification permission is a prompt they can
      // only answer wrongly. The cost of that gate is that the FIRST
      // notification of a session cannot be shown (the prompt has not been
      // answered yet) — unavoidable in any case, since permission cannot be
      // obtained without a gesture, and a first signal rarely coincides with one.
      if (!armed || requested) {
        return;
      }
      const Ctor = env.ctor;
      if (!Ctor || env.permission() !== "default") {
        return; // absent API, or already granted/denied: nothing to ask
      }
      requested = true; // once per page, whatever the answer
      try {
        env.request();
      } catch {
        /* a browser that refuses to be asked is a tab-only browser */
      }
    },
    forget(id): void {
      lastSeq.delete(id);
    },
  };
}

/** browserNotifierEnv binds a notifier to the real browser APIs. The single
 *  place in this feature that touches globals, and it reads them through
 *  `unknown` on purpose: `Notification` is absent (not merely denied) on iOS
 *  Safari and in test DOMs, so nothing here may assume the declared global
 *  exists. Both `requestPermission` shapes are tolerated — modern browsers
 *  return a promise, older Safari takes a callback and returns undefined — since
 *  the result is not awaited: the answer is read from `permission()` at the next
 *  notification. */
export function browserNotifierEnv(): NotifierEnv {
  const api = (): { permission?: unknown; requestPermission?: unknown } | undefined => {
    const value: unknown = (globalThis as { Notification?: unknown }).Notification;
    return typeof value === "function"
      ? (value as unknown as { permission?: unknown; requestPermission?: unknown })
      : undefined;
  };
  return {
    get ctor(): NotificationCtorLike | undefined {
      const value: unknown = (globalThis as { Notification?: unknown }).Notification;
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
    // document.visibilityState is the only reliable "can the user see this page"
    // signal; document.hasFocus() is false for a visible-but-unfocused window,
    // where the terminal IS on screen and a notification would be redundant.
    pageVisible: (): boolean => document.visibilityState !== "hidden",
  };
}

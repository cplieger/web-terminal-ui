// activityMonitor: the server's status SSE as a read-only data source with no
// chrome of its own; peers read it through ctx.use. The server's snapshot on a
// (re)open carries no tombstones for sessions a REPLACEMENT server never knew,
// so the open is surfaced through onStreamOpen for a consumer to reconcile on.

import type { SessionStatus } from "@cplieger/web-terminal-engine";
import type { TerminalFeature, Unsubscribe } from "../kernel/types.js";

const DEFAULT_EVENTS_PATH = "/api/sessions/events";

/** The live status of every session the server knows about. `current` answers
 *  from the last event seen, so it is undefined for a session no event has
 *  covered yet and for one reported `removed`; a caller that needs "eventually"
 *  subscribes. */
export interface ActivityMonitorApi {
  /** Every status update, the initial snapshot included. */
  onStatus(cb: (s: SessionStatus) => void): Unsubscribe;
  /** The last known status for a session, or undefined. */
  current(id: string): SessionStatus | undefined;
  /** Every stream (re)open; a subscriber attaching after one has happened is
   *  called at once. Optional so an alternative monitor stays valid. */
  onStreamOpen?(cb: () => void): Unsubscribe;
}

/** Build the activityMonitor feature. On a server without the SSE endpoint the
 *  stream never opens and no subscriber fires, which is why `tabs` treats the
 *  monitor as optional. Order it BEFORE any feature that reads it through
 *  `ctx.use`. A throwing subscriber is logged, never propagated: it must not
 *  skip the remaining subscribers or kill the stream for everyone. */
export function activityMonitor(
  opts: { eventsPath?: string } = {},
): TerminalFeature<ActivityMonitorApi> {
  return {
    name: "activityMonitor",
    scope: "shell",
    setup(ctx) {
      const path = opts.eventsPath ?? DEFAULT_EVENTS_PATH;
      const statuses = new Map<string, SessionStatus>();
      const subs = new Set<(s: SessionStatus) => void>();
      const openSubs = new Set<() => void>();
      let opens = 0;

      const offStream = ctx.shell.subscribeStatus(path, {
        onOpen() {
          opens++;
          for (const cb of [...openSubs]) {
            try {
              cb();
            } catch (err) {
              console.error("web-terminal-ui: activityMonitor open subscriber threw", err);
            }
          }
        },
        onStatus(s) {
          if (s.removed) {
            statuses.delete(s.id);
          } else {
            statuses.set(s.id, s);
          }
          for (const cb of [...subs]) {
            try {
              cb(s);
            } catch (err) {
              console.error("web-terminal-ui: activityMonitor subscriber threw", err);
            }
          }
        },
      });
      ctx.defer(offStream);

      return {
        api: {
          onStatus(cb) {
            subs.add(cb);
            return () => subs.delete(cb);
          },
          current(id) {
            return statuses.get(id);
          },
          onStreamOpen(cb) {
            openSubs.add(cb);
            if (opens > 0) {
              cb();
            }
            return () => openSubs.delete(cb);
          },
        },
        teardown() {
          subs.clear();
          openSubs.clear();
          statuses.clear();
        },
      };
    },
  };
}

// activityMonitor feature: subscribes to the server's status SSE
// (/api/sessions/events via the engine's connectStatusStream) and exposes each
// session's live status through its API (design sections 7, 22.4, 22.5). It is a
// pure data source with no chrome of its own; the tabs feature consumes it via
// ctx.use to render per-tab activity dots and drop exited/removed tabs. The
// server pushes an initial snapshot on every (re)open — but the snapshot
// carries no tombstones for sessions a REPLACEMENT server never knew (manager
// restart), so the stream-open signal is surfaced via onStreamOpen and the
// consumer (tabs) runs a one-shot GET /api/sessions reconcile there to drop
// zombie tabs.

import { connectStatusStream } from "@cplieger/web-terminal-engine";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import type { TerminalFeature, Unsubscribe } from "../kernel/types.js";

const DEFAULT_EVENTS_PATH = "/api/sessions/events";

export interface ActivityMonitorApi {
  /** Subscribe to every status update (working/idle/input/exited, plus removed).
   *  Fired for the initial snapshot and each change. */
  onStatus(cb: (s: SessionStatus) => void): Unsubscribe;
  /** The last known status for a session, or undefined. */
  current(id: string): SessionStatus | undefined;
  /** Subscribe to stream (re)open events — fired on the initial SSE connect
   *  and every reconnect (including the reopen against a restarted server,
   *  whose fresh snapshot cannot tombstone sessions it never knew). A
   *  subscriber attaching after an open has already happened is called
   *  immediately (catch-up), so a late consumer never misses the initial
   *  open. Optional so alternative monitor implementations remain valid. */
  onStreamOpen?(cb: () => void): Unsubscribe;
}

export function activityMonitor(
  opts: { eventsPath?: string } = {},
): TerminalFeature<ActivityMonitorApi> {
  return {
    name: "activityMonitor",
    setup() {
      const path = opts.eventsPath ?? DEFAULT_EVENTS_PATH;
      const statuses = new Map<string, SessionStatus>();
      const subs = new Set<(s: SessionStatus) => void>();
      const openSubs = new Set<() => void>();
      let opens = 0;

      const stream = connectStatusStream(path, {
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
              // Isolate a throwing subscriber so it neither skips the
              // remaining subscribers nor propagates into the engine's
              // SSE reader (mirrors the kernel bus's ctx.on wrapping).
              console.error("web-terminal-ui: activityMonitor subscriber threw", err);
            }
          }
        },
      });

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
              cb(); // catch-up: the stream opened before this subscriber attached
            }
            return () => openSubs.delete(cb);
          },
        },
        teardown() {
          stream.close();
          subs.clear();
          openSubs.clear();
          statuses.clear();
        },
      };
    },
  };
}

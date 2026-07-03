// activityMonitor feature: subscribes to the server's status SSE
// (/api/sessions/events via the engine's connectStatusStream) and exposes each
// session's live status through its API (design sections 7, 22.4, 22.5). It is a
// pure data source with no chrome of its own; the tabs feature consumes it via
// ctx.use to render per-tab activity dots and drop exited/removed tabs. The
// server pushes an initial snapshot on every (re)open, so no explicit resync is
// needed here.

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
}

export function activityMonitor(opts: { eventsPath?: string } = {}): TerminalFeature<ActivityMonitorApi> {
  return {
    name: "activityMonitor",
    setup() {
      const path = opts.eventsPath ?? DEFAULT_EVENTS_PATH;
      const statuses = new Map<string, SessionStatus>();
      const subs = new Set<(s: SessionStatus) => void>();

      const stream = connectStatusStream(path, {
        onStatus(s) {
          if (s.removed) {
            statuses.delete(s.id);
          } else {
            statuses.set(s.id, s);
          }
          for (const cb of [...subs]) {
            cb(s);
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
        },
        teardown() {
          stream.close();
          subs.clear();
          statuses.clear();
        },
      };
    },
  };
}

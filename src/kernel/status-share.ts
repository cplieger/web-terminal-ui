// One status stream per path for the whole page, shared by every subscriber:
// the server caps its stream subscribers, so two features that both want the
// live session set must not cost two connections.

import type { StatusStream, StatusStreamCallbacks } from "@cplieger/web-terminal-engine";
import type { Unsubscribe } from "./types.js";

/** Opens the server's status stream at a path; the engine's `connectStatusStream`
 *  in production. */
export type StatusConnector = (path: string, callbacks: StatusStreamCallbacks) => StatusStream;

/** The shell's shared status streams. */
export interface StatusShare {
  /** Subscribe to the stream at `path`. The first subscriber opens it, the last
   *  one's unsubscribe closes it; a subscriber joining a stream that has already
   *  opened has its `onOpen` called at once, since the stream carries only future
   *  changes and that subscriber missed the open it would resync on. */
  subscribe(path: string, callbacks: StatusStreamCallbacks): Unsubscribe;
  /** Close every stream. A later unsubscribe releases nothing and throws nothing. */
  dispose(): void;
}

interface SharedStream {
  readonly stream: StatusStream;
  readonly subscribers: Set<StatusStreamCallbacks>;
  opened: boolean;
}

function fanOut(
  subscribers: Set<StatusStreamCallbacks>,
  call: (cb: StatusStreamCallbacks) => void,
): void {
  for (const cb of [...subscribers]) {
    try {
      call(cb);
    } catch (err) {
      console.error("web-terminal-ui: status stream subscriber threw", err);
    }
  }
}

export function createStatusShare(connect: StatusConnector): StatusShare {
  const streams = new Map<string, SharedStream>();

  function open(path: string): SharedStream {
    const subscribers = new Set<StatusStreamCallbacks>();
    const shared: SharedStream = {
      subscribers,
      opened: false,
      stream: connect(path, {
        onOpen() {
          shared.opened = true;
          fanOut(subscribers, (cb) => cb.onOpen?.());
        },
        onStatus(status) {
          fanOut(subscribers, (cb) => {
            cb.onStatus(status);
          });
        },
        onError() {
          fanOut(subscribers, (cb) => cb.onError?.());
        },
      }),
    };
    streams.set(path, shared);
    return shared;
  }

  return {
    subscribe(path, callbacks) {
      const shared = streams.get(path) ?? open(path);
      shared.subscribers.add(callbacks);
      if (shared.opened) {
        callbacks.onOpen?.();
      }
      return () => {
        shared.subscribers.delete(callbacks);
        if (shared.subscribers.size > 0) {
          return;
        }
        if (streams.get(path) === shared) {
          streams.delete(path);
          shared.stream.close();
        }
      };
    },
    dispose() {
      for (const shared of streams.values()) {
        shared.subscribers.clear();
        shared.stream.close();
      }
      streams.clear();
    },
  };
}

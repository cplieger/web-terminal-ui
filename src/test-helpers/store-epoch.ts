import type { LineStore } from "@cplieger/web-terminal-engine";

/** Apply a resumeAck that reports `epoch` and nothing else, as a connection does
 *  for an older server's ack; returns whether the store discarded its content. */
export function ackEpoch(store: LineStore, epoch: number | null): boolean {
  return store.applyResumeAck({
    serverEpoch: epoch,
    committed: null,
    serverOldest: null,
    paging: false,
    sentHaveThrough: -1,
    sentReplayMax: null,
    viewportAbs: 0,
    following: true,
  });
}

// Typed event bus for the kernel/feature contract. A small pub/sub keyed by the
// TerminalEvents map, so a subscriber gets the exact payload type for its event
// and the kernel emits with the same guarantee (no `unknown`, section 22.4).
//
// The bus itself does not attribute errors to features; the kernel wraps each
// feature's ctx.on handler with a try/catch that routes to ctx.onError with the
// feature name, so a throwing handler is isolated and named there.

import type { TerminalEvents, Unsubscribe } from "./types.js";

/** A typed event bus over TerminalEvents. */
export interface TypedBus {
  on<K extends keyof TerminalEvents>(e: K, fn: (p: TerminalEvents[K]) => void): Unsubscribe;
  emit<K extends keyof TerminalEvents>(e: K, p: TerminalEvents[K]): void;
  /** Drop every listener (used on kernel destroy). */
  clear(): void;
}

// A handler for any event. `(p: never) => void` is the bottom of the
// contravariant handler lattice: every concrete `(p: TerminalEvents[K]) => void`
// is assignable to it, so one Set can hold handlers for a single key uniformly.
// The exact payload type is recovered with a single controlled cast at emit.
type AnyHandler = (p: never) => void;

export function createBus(): TypedBus {
  const listeners = new Map<keyof TerminalEvents, Set<AnyHandler>>();

  function on<K extends keyof TerminalEvents>(
    e: K,
    fn: (p: TerminalEvents[K]) => void,
  ): Unsubscribe {
    let set = listeners.get(e);
    if (!set) {
      set = new Set<AnyHandler>();
      listeners.set(e, set);
    }
    set.add(fn);
    return () => {
      listeners.get(e)?.delete(fn);
    };
  }

  function emit<K extends keyof TerminalEvents>(e: K, p: TerminalEvents[K]): void {
    const set = listeners.get(e);
    if (!set) {
      return;
    }
    // Snapshot so a handler that subscribes/unsubscribes during dispatch does
    // not mutate the set we are iterating. The cast recovers the payload type
    // this key's handlers were registered with.
    for (const fn of [...set]) {
      (fn as (p: TerminalEvents[K]) => void)(p);
    }
  }

  function clear(): void {
    listeners.clear();
  }

  return { on, emit, clear };
}

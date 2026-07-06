import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createBus } from "./bus.js";

describe("createBus: fan-out and payload delivery", () => {
  it("delivers the emitted payload to every subscriber of that event, in order", () => {
    const bus = createBus();
    const seen: string[] = [];
    bus.on("connection:state", (s) => seen.push(`a:${s}`));
    bus.on("connection:state", (s) => seen.push(`b:${s}`));
    bus.emit("connection:state", "offline");
    expect(seen).toEqual(["a:offline", "b:offline"]);
  });

  it("does not deliver an event to subscribers of a different event", () => {
    const bus = createBus();
    let scrollCalls = 0;
    bus.on("scroll:state", () => {
      scrollCalls++;
    });
    bus.emit("connection:state", "open");
    expect(scrollCalls).toBe(0);
  });

  it("emitting an event with no subscribers is a no-op", () => {
    const bus = createBus();
    expect(() => {
      bus.emit("connection:state", "open");
    }).not.toThrow();
  });
});

describe("createBus: unsubscribe", () => {
  it("the returned unsubscribe removes only that handler", () => {
    const bus = createBus();
    let a = 0;
    let b = 0;
    const offA = bus.on("connection:state", () => {
      a++;
    });
    bus.on("connection:state", () => {
      b++;
    });
    bus.emit("connection:state", "open");
    offA();
    bus.emit("connection:state", "open");
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("a double unsubscribe is idempotent", () => {
    const bus = createBus();
    let calls = 0;
    const off = bus.on("connection:state", () => {
      calls++;
    });
    off();
    off();
    bus.emit("connection:state", "open");
    expect(calls).toBe(0);
  });
});

describe("createBus: snapshot semantics during dispatch", () => {
  it("a handler unsubscribed by an earlier handler mid-dispatch still fires for the in-flight emit", () => {
    const bus = createBus();
    const seen: string[] = [];
    let offB = (): void => undefined;
    bus.on("connection:state", () => {
      seen.push("a");
      offB();
    });
    offB = bus.on("connection:state", () => {
      seen.push("b");
    });
    bus.emit("connection:state", "open");
    // b was removed by a during this dispatch but still ran (iteration is over a snapshot).
    expect(seen).toEqual(["a", "b"]);
    seen.length = 0;
    bus.emit("connection:state", "open");
    // On the next emit b is gone.
    expect(seen).toEqual(["a"]);
  });
});

describe("createBus: clear", () => {
  it("clear() drops every listener across all events", () => {
    const bus = createBus();
    let calls = 0;
    bus.on("connection:state", () => {
      calls++;
    });
    bus.on("scroll:state", () => {
      calls++;
    });
    bus.clear();
    bus.emit("connection:state", "open");
    bus.emit("scroll:state", { scrolledUp: true });
    expect(calls).toBe(0);
  });
});

describe("createBus: property - every emit reaches every current subscriber", () => {
  it("total delivery count equals subscriber count times emit count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        (nSubs, nEmits) => {
          const bus = createBus();
          let calls = 0;
          for (let i = 0; i < nSubs; i++) {
            bus.on("wire:clipboard", () => {
              calls++;
            });
          }
          for (let j = 0; j < nEmits; j++) {
            bus.emit("wire:clipboard", "x");
          }
          expect(calls).toBe(nSubs * nEmits);
        },
      ),
    );
  });
});

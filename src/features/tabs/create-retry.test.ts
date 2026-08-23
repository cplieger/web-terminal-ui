// createSessionHonouringRetry: the loop that answers a host which TEMPORARILY
// refuses session creation (web-terminal-kiro's 503 + Retry-After while its tool
// engine installs the manifest's tools on first boot). index.test.ts covers the
// happy shape of that retry — it retries on the server's hint, it repeats the
// server's words, and a 500 fails fast. What is pinned here is the loop's own
// arithmetic, which those tests never reach: the ELAPSED-TIME bound that ends the
// wait, the throttle that keeps a twenty-minute wait from becoming a toast storm,
// the fallback delay when the server sent no usable hint, and the teardown check
// that stops a destroyed page from resurrecting a create.
//
// Every case here drives the real feature through the real kernel; the only fake
// is fetch at the REST boundary, using real Response objects so Retry-After and
// the error envelope are parsed by the production parser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as KernelModule from "../../kernel/kernel.js";
import type * as TabsModule from "./index.js";

let createTerminal: (typeof KernelModule)["createTerminal"];
let tabs: (typeof TabsModule)["tabs"];
let term: ReturnType<(typeof KernelModule)["createTerminal"]> | undefined;

// The loop's own constants, restated here as the numbers the SERVER sees rather
// than imported: the module does not export them, and a test that reached into
// the module for them could not tell a retuned bound from a broken one.
const MAX_TOTAL_MS = 1200000; // the elapsed-time ceiling on the whole wait
const REANNOUNCE_MS = 60000; // how often the wait re-announces itself

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// A controllable clock. The retry bound is measured in elapsed milliseconds, so a
// test that wants to stand at the boundary has to own Date.now rather than wait
// out twenty real minutes.
let now = 0;

// POST bodies the server hands back, one per attempt; the last entry repeats once
// the attempts outrun the script.
interface Refusal {
  status: number;
  message?: string;
  retryAfter?: string;
  /** Advance the fake clock to this instant before answering. */
  at?: number;
}
let script: Refusal[];
let posts = 0;
// Armed by a test that wants the page torn down mid-wait.
let destroyOnPost = 0;

const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method !== "POST") {
    return Promise.resolve(jsonResponse([], 200)); // no live sessions: the bootstrap must create
  }
  posts++;
  if (destroyOnPost === posts) {
    // Fires while the loop's own wait timer is still pending: this timer is armed
    // first, and the loop only arms its own after the rejection has propagated.
    setTimeout(() => {
      term?.destroy();
      term = undefined;
    }, 0);
  }
  const step = script[Math.min(posts - 1, script.length - 1)];
  if (!step) {
    return Promise.resolve(
      jsonResponse({ id: "s-new", title: "", createdAt: "1", status: "idle" }, 201),
    );
  }
  if (step.at !== undefined) {
    now = step.at;
  }
  if (step.status < 400) {
    return Promise.resolve(
      jsonResponse({ id: "s-new", title: "", createdAt: "1", status: "idle" }, step.status),
    );
  }
  return Promise.resolve(
    jsonResponse(
      { error: step.message ?? "not ready" },
      step.status,
      step.retryAfter === undefined ? undefined : { "Retry-After": step.retryAfter },
    ),
  );
});

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockClear();
  posts = 0;
  destroyOnPost = 0;
  now = 0;
  script = [];
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", fetchMock);
  document.body.replaceChildren();
  localStorage.clear();
  ({ createTerminal } = await import("../../kernel/kernel.js"));
  ({ tabs } = await import("./index.js"));
});

afterEach(() => {
  term?.destroy();
  term = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function until(pred: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// Let the loop run to a standstill: enough turns for several more attempts than
// any case here expects, so a loop that should have stopped is caught running.
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function mount(loading?: HTMLElement): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  // Spread rather than pass `loading: undefined`: the kernel's options are
  // exactOptionalPropertyTypes, so an absent overlay is an ABSENT key.
  term = createTerminal(root, { features: () => [tabs()], ...(loading ? { loading } : {}) });
  return root;
}

function toastText(root: HTMLElement): string {
  return root.querySelector(".wt-toast")?.textContent ?? "";
}

describe("session-create retry: the elapsed-time bound", () => {
  it("gives up once the wait has spent its whole budget, carrying the server's reason", async () => {
    // Two refusals: the first well inside the budget, the second landing exactly
    // ON the ceiling. The bound is inclusive, so the second is the last one.
    script = [
      { status: 503, message: "installing tools", retryAfter: "0", at: 10 },
      { status: 503, message: "installing tools", retryAfter: "0", at: MAX_TOTAL_MS },
    ];
    const root = mount();

    await until(() => toastText(root).startsWith("Couldn't open a terminal"), 120);
    await settle();
    expect(posts).toBe(2);
    // The give-up message repeats the host's own explanation rather than the
    // generic wording, which is the only thing a user can act on.
    expect(toastText(root)).toBe("Couldn't open a terminal: installing tools");
  });

  it("keeps waiting while the budget still has a millisecond left", async () => {
    // One millisecond under the ceiling is still inside it: this attempt must
    // wait rather than give up, which is what separates the bound from an
    // off-by-one that ends the wait a tick early.
    script = [
      { status: 503, retryAfter: "0", at: MAX_TOTAL_MS - 1 },
      { status: 201, at: MAX_TOTAL_MS },
    ];
    const root = mount();

    await until(() => root.querySelectorAll(".wt-tab").length === 1, 120);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    expect(posts).toBe(2);
    // Still the waiting line, never the give-up line: the budget was not spent.
    expect(toastText(root)).toBe("not ready; waiting…");
  });

  it("does not retry a refusal the server never called temporary", async () => {
    // A 429 is a rate limit and a 500 is a broken server; neither is "come back
    // shortly", so both end the wait on the first answer.
    script = [{ status: 429, message: "slow down", retryAfter: "0" }];
    const root = mount();

    await until(() => toastText(root).startsWith("Couldn't open a terminal"), 120);
    await settle();
    expect(posts).toBe(1);
    expect(toastText(root)).toBe("Couldn't open a terminal: slow down");
  });
});

describe("session-create retry: what the user is told", () => {
  it("says the wait once, not once per attempt", async () => {
    // The refusals carry DIFFERENT explanations, so the toast reveals which
    // attempt last spoke. Inside one re-announce window only the first may:
    // a page that retries for twenty minutes must be neither silent nor a storm.
    //
    // The two instants are deep into the wait and 10s apart, so what separates
    // them is the GAP and not their size: a rule that added the two readings
    // instead of subtracting them would clear the window here and speak twice.
    script = [
      { status: 503, message: "first reason", retryAfter: "0", at: 30000 },
      { status: 503, message: "second reason", retryAfter: "0", at: 40000 },
      { status: 201, at: 40010 },
    ];
    const root = mount();

    await until(() => root.querySelectorAll(".wt-tab").length === 1, 120);
    expect(posts).toBe(3);
    expect(toastText(root)).toBe("first reason; waiting…");
  });

  it("announces the wait to a screen reader as well as to the toast layer", async () => {
    // The toast is decoration to a screen-reader user; the live region is the
    // channel that reaches them, and it carries the same sentence.
    script = [
      { status: 503, message: "installing tools", retryAfter: "0", at: 10 },
      { status: 201, at: 20 },
    ];
    const root = mount();

    await until(() => root.querySelectorAll(".wt-tab").length === 1, 120);
    // The announcer clears the region and re-sets it on a short timer, so the
    // sentence lands a beat after the call.
    await new Promise((r) => setTimeout(r, 150));
    expect(root.querySelector("[aria-live=polite]")?.textContent).toContain(
      "installing tools; waiting…",
    );
  });

  it("speaks again once the re-announce window has passed", async () => {
    // A wait long enough to outlast the window earns a fresh line: the second
    // reason is what the user is now waiting on.
    script = [
      { status: 503, message: "first reason", retryAfter: "0", at: 10 },
      { status: 503, message: "second reason", retryAfter: "0", at: 10 + REANNOUNCE_MS },
      { status: 201, at: 20 + REANNOUNCE_MS },
    ];
    const root = mount();

    await until(() => root.querySelectorAll(".wt-tab").length === 1, 120);
    expect(posts).toBe(3);
    expect(toastText(root)).toBe("second reason; waiting…");
  });

  it("throttles from the FIRST refusal even when it arrives on the same millisecond", async () => {
    // The clock has not moved when the first refusal lands (a server on the same
    // host answers inside a millisecond), so the elapsed reading is 0. That must
    // still count as "already spoken": 0 is a legitimate elapsed value, not the
    // absence of an announcement.
    script = [
      { status: 503, message: "first reason", retryAfter: "0", at: 0 },
      { status: 503, message: "second reason", retryAfter: "0", at: 0 },
      { status: 201, at: 0 },
    ];
    const root = mount();

    await until(() => root.querySelectorAll(".wt-tab").length === 1, 120);
    expect(posts).toBe(3);
    expect(toastText(root)).toBe("first reason; waiting…");
  });

  it("writes the reason onto the loading overlay, which is the only surface up yet", async () => {
    // The toast and the banner both paint UNDER the consumer's loading overlay,
    // so before the first frame this is the one channel a user can actually read.
    script = [
      { status: 503, message: "installing tools", retryAfter: "0", at: 10 },
      { status: 201, at: 20 },
    ];
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const root = mount(loading);

    await until(() => (loading.textContent ?? "").includes("installing tools"), 120);
    expect(loading.querySelector(".wt-loading-text")?.textContent).toBe(
      "installing tools; waiting…",
    );
    await until(() => root.querySelectorAll(".wt-tab").length === 1, 120);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
  });

  it("falls back to library wording when the server refused without explaining", async () => {
    script = [
      { status: 503, retryAfter: "0", at: 10 },
      { status: 201, at: 20 },
    ];
    // A 503 whose body carries no message at all.
    fetchMock.mockImplementation((_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "POST") {
        return Promise.resolve(jsonResponse([], 200));
      }
      posts++;
      now = posts * 10;
      if (posts === 1) {
        return Promise.resolve(jsonResponse({}, 503, { "Retry-After": "0" }));
      }
      return Promise.resolve(
        jsonResponse({ id: "s-new", title: "", createdAt: "1", status: "idle" }, 201),
      );
    });
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const root = mount(loading);

    await until(() => root.querySelectorAll(".wt-tab").length === 1, 120);
    expect(loading.querySelector(".wt-loading-text")?.textContent).toBe(
      "Server is not ready yet; waiting…",
    );
  });
});

describe("session-create retry: the delay itself", () => {
  it("waits its own fallback when the server sent no usable hint", async () => {
    // No Retry-After at all. The fallback is seconds long, so within this test's
    // window the second attempt must NOT have happened: a loop that treated the
    // missing hint as "no delay" would hammer the server it was asked to spare.
    script = [{ status: 503, message: "no hint", at: 10 }];
    mount();

    await until(() => posts >= 1, 120);
    await settle();
    expect(posts).toBe(1);
  });
});

describe("session-create retry: teardown", () => {
  it("abandons the wait when the page is destroyed under it", async () => {
    // A reload or a destroy during the wait must not resurrect a create: the
    // session would be spawned for a page that is already gone, and nothing
    // would ever close it.
    script = [{ status: 503, message: "installing tools", retryAfter: "0", at: 10 }];
    destroyOnPost = 1;
    mount();

    await until(() => posts >= 1, 120);
    await settle();
    expect(posts).toBe(1);
  });
});

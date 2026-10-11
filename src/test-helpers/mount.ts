// The one way a test builds a terminal: the handle is recorded so the setup
// file's afterEach destroys it, which keeps the document's one-terminal rule
// from failing the next case.

import { beforeAll } from "vitest";
import type { CreateTerminalOptions, TerminalHandle } from "../kernel/types.js";
import { record } from "./mounted-registry.js";

// Loads the kernel's module graph under hookTimeout, as a static import would load
// it at collection, rather than inside the testTimeout of a file's first mount.
// The file's hoisted `vi.mock` calls are registered by its first hook.
beforeAll(async () => {
  await import("../kernel/kernel.js");
});

/** `createTerminal(target, opts)`, imported on each call so a test file's mock of
 *  the engine module is in place first, and recorded for the afterEach destroy. */
export async function mountTerminal(
  target: HTMLElement | string,
  opts: CreateTerminalOptions = {},
): Promise<TerminalHandle> {
  const { createTerminal } = await import("../kernel/kernel.js");
  return record(createTerminal(target, opts));
}

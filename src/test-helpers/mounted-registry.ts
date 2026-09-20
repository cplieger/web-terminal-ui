// The terminals a test mounted, so one afterEach can destroy them all: a
// document holds at most one live terminal, and a case that leaves one alive
// would fail the next case's createTerminal at kernel-init. Imports no production
// source, so the setup file that loads it cannot pre-empt a test file's mock of
// the engine module.

interface Destroyable {
  destroy(): void;
}

const mounted: Destroyable[] = [];

/** Remember a mounted terminal. */
export function record<T extends Destroyable>(handle: T): T {
  mounted.push(handle);
  return handle;
}

/** Destroy every remembered terminal, newest first. */
export function destroyMounted(): void {
  while (mounted.length > 0) {
    mounted.pop()?.destroy();
  }
}

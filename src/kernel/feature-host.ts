import type { FeatureInstance, TerminalContext, TerminalFeature, Unsubscribe } from "./types.js";

/** Releases run last-in first-out: what one feature acquired, or what a pane or
 *  the shell holds. */
export interface CleanupScope {
  /** Hold `release` until the drain. After the drain it runs at once, so a setup
   *  still running past its owner's teardown cannot leave anything behind. */
  push(release: Unsubscribe): void;
  drain(): void;
}

export function createCleanupScope(reportError: (err: unknown) => void): CleanupScope {
  const releases: Unsubscribe[] = [];
  let drained = false;
  const run = (release: Unsubscribe): void => {
    try {
      release();
    } catch (err) {
      reportError(err);
    }
  };
  return {
    push(release) {
      if (drained) {
        run(release);
        return;
      }
      releases.push(release);
    },
    drain() {
      drained = true;
      while (releases.length > 0) {
        const release = releases.pop();
        if (release) {
          run(release);
        }
      }
    },
  };
}

export type FeatureSetupOutcome =
  | { readonly status: "ready" }
  | { readonly status: "aborted" }
  | { readonly status: "failed"; readonly feature: string; readonly cause: unknown };

interface Entry {
  readonly feature: TerminalFeature<unknown>;
  readonly instance: FeatureInstance<unknown>;
  readonly scope: CleanupScope;
}

export interface FeatureHost {
  /** Set one feature up. The scope exists before `setup` runs, so a throw drains
   *  what the feature acquired; a `destroyed()` true after the await tears the
   *  instance down instead of registering it. */
  setup(
    feature: TerminalFeature<unknown>,
    makeContext: (scope: CleanupScope) => TerminalContext,
    destroyed: () => boolean,
  ): Promise<FeatureSetupOutcome>;
  /** The set-up instances, in setup order. */
  instances(): readonly FeatureInstance<unknown>[];
  /** The api of a set-up feature, or undefined. */
  use(feature: TerminalFeature<unknown>): unknown;
  /** The scope of every setup still pending, then every instance's `teardown()`
   *  in reverse order, each followed by its scope. */
  teardownAll(): void;
}

export function createFeatureHost(
  reportError: (feature: string, err: unknown) => void,
): FeatureHost {
  const entries: Entry[] = [];
  const pending = new Set<CleanupScope>();
  const apiMap = new Map<TerminalFeature<unknown>, unknown>();

  return {
    async setup(feature, makeContext, destroyed) {
      // A feature enters `entries` only after `setup` returns, so the scope is
      // the one owner of what a throwing or still-pending `setup` acquired.
      const scope = createCleanupScope((err) => {
        reportError(feature.name, err);
      });
      pending.add(scope);
      try {
        const instance = await feature.setup(makeContext(scope));
        pending.delete(scope);
        if (destroyed()) {
          try {
            instance.teardown();
          } catch (err) {
            reportError(feature.name, err);
          }
          scope.drain();
          return { status: "aborted" };
        }
        entries.push({ feature, instance, scope });
        (feature as { api?: unknown }).api = instance.api;
        apiMap.set(feature, instance.api);
      } catch (cause) {
        pending.delete(scope);
        scope.drain();
        if (destroyed()) {
          return { status: "aborted" };
        }
        reportError(feature.name, cause);
        console.error(`web-terminal-ui: feature "${feature.name}" setup failed`, cause);
        return { status: "failed", feature: feature.name, cause };
      }
      return { status: "ready" };
    },
    instances: () => entries.map((e) => e.instance),
    use: (feature) => apiMap.get(feature),
    teardownAll() {
      for (const scope of pending) {
        scope.drain();
      }
      pending.clear();
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry) {
          continue;
        }
        try {
          entry.instance.teardown();
        } catch (err) {
          reportError(entry.feature.name, err);
        }
        entry.scope.drain();
      }
      entries.length = 0;
      apiMap.clear();
    },
  };
}

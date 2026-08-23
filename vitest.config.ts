// Vitest configuration for @cplieger/web-terminal-ui unit tests.
//
// Two projects, and the DEFAULT is the browser. A test file runs in a real
// headless Chromium unless its name opts out, because the browser is the
// environment this package actually ships into and a DOM emulator got a long
// list of these assertions wrong for free (real layout, a real visualViewport,
// real TouchEvent/DragEvent/AnimationEvent constructors, the real selection
// fixup after a subtree is detached).
//
// The opt-out is the `.node.test.ts` suffix, and it is load-bearing rather than
// decorative: placement has to be readable off the filename because one of the
// two reasons a file needs Node fails SILENTLY when it is misplaced.
//
//   - A test that needs Node capabilities (reading the stylesheets with
//     `node:fs`, writing a golden under UPDATE_GOLDEN=1) throws on the import
//     when it lands in the browser. Loud, self-correcting.
//   - A test that needs a browser capability to be ABSENT does not. It passes
//     vacuously, having exercised the arm it was written to avoid. Those tests
//     therefore do NOT belong in the node project either: Node has no
//     `document` at all, which is a third wrong reason to pass. They stay in
//     the browser project and remove the one capability at the site.
//
// Run: vitest --run (single pass) or vitest (watch mode).
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `extends: true` on every project is REQUIRED, not decorative: a project
    // inherits NOTHING from this block without it, and losing a strictness
    // option (expect.requireAssertions, allowOnly, mockReset, unstubGlobals,
    // the timeouts, setupFiles) never fails a test, so the suite would go green
    // while the bar dropped. It is a SIBLING of `test`, not a key inside it:
    // spelled `test: { extends: true }` it type-checks, runs, and inherits
    // nothing (measured on vitest 4.1.11 — setupFiles never loaded and a 2.5s
    // test passed under a 2s testTimeout). Verified the other way by dropping a
    // zero-assertion probe test into each project and confirming it FAILS.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.node.test.ts"],
          // .stryker-tmp holds Stryker's sandbox, a full copy of this
          // directory. A run that dies before cleanTempDir leaves it behind,
          // and without this the next plain `vitest --run` collects every test
          // twice.
          exclude: ["node_modules/**", "**/.stryker-tmp/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.node.test.ts", "node_modules/**", "**/.stryker-tmp/**"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: {
                channel: "chromium",
              },
            }),
            instances: [{ browser: "chromium" }],
            // Fixed viewport so layout-dependent assertions are reproducible;
            // a real browser computes real boxes.
            viewport: { width: 1280, height: 720 },
            // A failure screenshot per failing test is noise in CI and cannot
            // be read from a job log; the assertion diff is the artifact.
            screenshotFailures: false,
          },
        },
      },
    ],
    passWithNoTests: false,
    allowOnly: false,
    globals: false,
    expect: {
      requireAssertions: true,
    },
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    bail: process.env["CI"] ? 1 : 0,
    testTimeout: 2000,
    hookTimeout: 5000,
    // Root-only in vitest 4: it cannot be set per project.
    slowTestThreshold: 100,
    sequence: {
      shuffle: { files: false, tests: false },
      concurrent: false,
      hooks: "stack",
    },
    // Test-only setup files are named `*-setup.ts` and loaded here in order.
    // That suffix is the convention every publish and analysis filter matches on
    // (package.json `files`, jsr.json `publish.exclude`, stryker `mutate`, the
    // coverage exclude below, scripts/verify.sh): they import vitest, which a
    // consumer does not install, so shipping one breaks the consumer's build.
    // Name any new setup file `*-setup.ts` and every filter covers it already.
    setupFiles: ["./src/fc-strict-setup.ts"],
    printConsoleTrace: true,
    expandSnapshotDiff: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/*-setup.ts"],
      reportOnFailure: true,
      reporter: ["text", "text-summary", "lcov"],
    },
    chaiConfig: {
      truncateThreshold: 0,
      showDiff: true,
      includeStack: true,
    },
    experimental: {
      fsModuleCache: true,
      fsModuleCachePath: ".vitest-cache",
    },
  },
});

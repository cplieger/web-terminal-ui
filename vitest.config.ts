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

// Trace view records a DOM snapshot per browser interaction, and the recording
// is only readable through a reporter that serves it. VITEST_TRACE=1 turns on
// both halves together, so one variable produces something openable:
//
//   VITEST_TRACE=1 npx vitest run src/features/tabs/chip-geometry.test.ts
//   then open .vitest/index.html
//
// Off by default because the snapshots cost time on every browser test and CI
// has nowhere to publish them. `singleFile` inlines the UI assets so the report
// is one file to open or attach to an issue, rather than a directory that needs
// `vite preview` to serve it. This adds no devDependency: the html reporter's
// @vitest/ui is a hard dependency of @vitest/browser, which is already declared.
const traceView = process.env["VITEST_TRACE"] === "1";

export default defineConfig({
  test: {
    ...(traceView ? { reporters: ["default", ["html", { singleFile: true }]] as const } : {}),
    // `extends` is a key of the PROJECT, a sibling of `test` and never a key
    // inside it: spelled `test: { extends: true }` it type-checks, runs, and
    // inherits nothing (measured on vitest 4.1.11 — setupFiles never loaded and
    // a 2.5s test passed under a 2s testTimeout). That trap is why the value is
    // written out here even though vitest 5 defaults it to true: it puts the
    // correct placement in front of the next reader, and losing a strictness
    // option (expect.requireAssertions, allowOnly, mockReset, unstubGlobals,
    // the timeouts, setupFiles) never fails a test, so a mistake here would let
    // the suite go green while the bar dropped. Verified the other way by
    // dropping a zero-assertion probe test into each project and confirming it
    // FAILS.
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
            traceView,
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
    // Persist transformed modules across runs. Top-level since vitest 5, which
    // deprecated the `experimental.fsModuleCache` spelling this replaced (it
    // still worked, and warned twice per project per run).
    //
    // The path is explicit rather than the v5 default of
    // `node_modules/.vitest-cache`, because `.vitest-cache/` is already
    // gitignored here. The tradeoff is that the default location is discarded
    // by a reinstall while this one is not, and the cache key covers file
    // content, module id, Vite's environment config and coverage status, but
    // not installed dependency versions: delete it by hand
    // (`vitest --clearCache`) if a dependency bump ever serves a stale
    // transform.
    fsModuleCache: true,
    fsModuleCachePath: ".vitest-cache",
  },
});

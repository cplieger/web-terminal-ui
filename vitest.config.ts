// The browser project is the default: a test runs in headless Chromium unless
// its name ends in `.node.test.ts`. The suffix is load-bearing because only one
// misplacement fails loudly: a test needing Node (`node:fs`, a golden write)
// throws in the browser, while a test needing a browser capability ABSENT passes
// vacuously in Node too, so it stays in the browser and removes it at the site.
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// VITEST_TRACE=1 turns on trace view and the html reporter together, so one
// variable yields an openable report (.vitest/index.html). Off by default: the
// snapshots cost time on every browser test and CI has nowhere to publish them.
const traceView = process.env["VITEST_TRACE"] === "1";

export default defineConfig({
  test: {
    ...(traceView ? { reporters: ["default", ["html", { singleFile: true }]] as const } : {}),
    // `extends` is a key of the PROJECT, never of its `test`: spelled
    // `test: { extends: true }` it type-checks, runs and inherits nothing, and a
    // lost strictness option never fails a test. Written out although vitest 5
    // defaults it to true, so the correct placement is in front of the reader.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.node.test.ts"],
          // .stryker-tmp is Stryker's sandbox, a full copy of this directory; a
          // run that dies before cleanTempDir leaves it behind, and the next
          // plain `vitest --run` would then collect every test twice.
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
                // Chromium delivers animation frames at ~60Hz, so each frame a test awaits
                // costs it ~16.7ms; this removes the cap.
                args: ["--disable-frame-rate-limit"],
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
    // A setup file imports vitest, which a consumer does not install, so every
    // publish and analysis filter (package.json `files`, jsr.json, stryker, the
    // coverage exclude, scripts/verify.sh) excludes `*-setup.ts`: keep the name.
    setupFiles: ["./src/fc-strict-setup.ts", "./src/mounted-terminal-setup.ts"],
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
    // The path is `.vitest-cache`, already gitignored, rather than vitest 5's
    // `node_modules/.vitest-cache`. A reinstall does not discard it and the key
    // omits dependency versions, so after a dependency bump serves a stale
    // transform, clear it by hand (`vitest --clearCache`).
    fsModuleCache: true,
    fsModuleCachePath: ".vitest-cache",
  },
});

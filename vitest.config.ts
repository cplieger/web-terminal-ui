// Vitest configuration for @cplieger/web-terminal-ui unit tests.
// Default environment: node (pure functions, no DOM overhead). DOM-dependent
// test files opt in with `// @vitest-environment happy-dom` at the top.
// Run: vitest --run (single pass) or vitest (watch mode).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "threads",

    // Each test file gets its own module graph. isolate:false was faster but
    // unsound here: kernel.test.ts and kernel-persist.test.ts each replace the
    // WHOLE @cplieger/web-terminal-engine module with their own factory, and
    // with a shared registry whichever file loads first wins for the rest of
    // the worker. kernel.ts then called a function the other file's stub does
    // not define. The symptom moves with the packing order, which is the tell:
    // "render.dropBrowseCache is not a function" and
    // "scroll.stickToBottom is not a function" from consecutive runs of the
    // same commit. It only surfaces where workers are scarce enough to pack
    // those two files together, so it was invisible locally (34 files, 650
    // tests, all green) and failed on every 4-CPU CI run: 3 of 3 reproduced
    // when pinned to 4 CPUs. vibekit's config carries the same note after the
    // same bug. Measured cost here: 3.62s to 4.41s.
    isolate: true,

    include: ["src/**/*.test.ts"],
    // .stryker-tmp holds Stryker's sandbox, a full copy of this directory. A
    // run that dies before cleanTempDir leaves it behind, and without this the
    // next plain `vitest --run` collects every test twice.
    exclude: ["node_modules/**", "**/.stryker-tmp/**"],
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
    setupFiles: ["./src/fc-strict-setup.ts", "./src/dom-isolation-setup.ts"],
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

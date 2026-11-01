// Strict global fast-check defaults, loaded via vitest setupFiles.
//
// numRuns 1000: 10x default, still <1s per property at typical <100ms runtime.
// verbose VeryVerbose: a failure also prints every run as a status tree.
// interruptAfterTimeLimit plugin, 10s: outermost, so no per-call limit outlasts it.
// Only its own interrupt fails; a per-call limit needs its own failOnInterrupt.
// endOnFailure false: always shrink to the minimal counter-example.
// No fixed seed: a newly-discovered counter-example is a bug report, not flake.

import fc from "fast-check";

fc.configureGlobal({
  numRuns: 1000,
  verbose: fc.VerbosityLevel.VeryVerbose,
  endOnFailure: false,
});

fc.installGlobalPlugin(fc.interruptAfterTimeLimit(10000, { failOnInterrupt: true }));

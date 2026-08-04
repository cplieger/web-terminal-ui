// Strict typed-linting config for @cplieger/web-terminal-ui.
//
// The shared, org-synced ruleset lives in eslint.config.base.mjs (synced
// from cplieger/ci). Do NOT edit the base here — the next sync would clobber
// it. This file imports the base and layers the one repo-specific delta on
// top: the base is vendored as a bare `eslint.config.base.mjs` (a `.mjs` that
// does not match the base's `*.config.mjs` glob), so the lint run must allow
// it under the default project and drop type-checked rules for it. The same
// treatment covers `scripts/*.mjs` (the local verification harnesses, which are
// dev tooling outside the published tsconfig).

import baseConfig from "./eslint.config.base.mjs";

const LOCAL_MJS = ["*.mjs", "scripts/*.mjs"];

export default [
  ...baseConfig.map((block) => {
    // Project-setup block: add the local *.mjs globs to allowDefaultProject.
    // Kept as the single projectService block — a second global projectService
    // entry breaks tsconfig discovery for the test files.
    const adp = block.languageOptions?.parserOptions?.projectService?.allowDefaultProject;
    if (Array.isArray(adp)) {
      const missing = LOCAL_MJS.filter((glob) => !adp.includes(glob));
      if (missing.length > 0) {
        return {
          ...block,
          languageOptions: {
            ...block.languageOptions,
            parserOptions: {
              ...block.languageOptions.parserOptions,
              projectService: {
                ...block.languageOptions.parserOptions.projectService,
                allowDefaultProject: [...missing, ...adp],
              },
            },
          },
        };
      }
    }

    // disableTypeChecked block: the base lists only *.config.mjs, which misses
    // the bare-named vendored base and the scripts; add them so they aren't
    // type-checked.
    if (Array.isArray(block.files) && block.files.includes("*.config.mjs")) {
      const missing = LOCAL_MJS.filter((glob) => !block.files.includes(glob));
      if (missing.length > 0) {
        return { ...block, files: [...block.files, ...missing] };
      }
    }

    return block;
  }),
  {
    // The verification harnesses in scripts/ straddle two runtimes on purpose:
    // the file runs under Node, and the functions it hands to page.evaluate run
    // in the browser. Type-checked rules are off for them (above), which leaves
    // base-eslint's no-undef active with neither global set complete, so declare
    // the ones both halves actually use.
    files: ["scripts/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        document: "readonly",
        window: "readonly",
        getComputedStyle: "readonly",
      },
    },
  },
];

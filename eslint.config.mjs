// Strict typed-linting config for @cplieger/web-terminal-ui.
//
// The shared, org-synced ruleset lives in eslint.config.base.mjs (synced
// from cplieger/ci). Do NOT edit the base here — the next sync would clobber
// it. This file imports the base and layers the one repo-specific delta on
// top: the base is vendored as a bare `eslint.config.base.mjs` (a `.mjs` that
// does not match the base's `*.config.mjs` glob), so the lint run must allow
// it under the default project and drop type-checked rules for it.

import baseConfig from "./eslint.config.base.mjs";

const LOCAL_MJS = "*.mjs";

export default [
  ...baseConfig.map((block) => {
    // Project-setup block: add *.mjs to allowDefaultProject. Kept as the
    // single projectService block — a second global projectService entry
    // breaks tsconfig discovery for the test files.
    const adp = block.languageOptions?.parserOptions?.projectService?.allowDefaultProject;
    if (Array.isArray(adp) && !adp.includes(LOCAL_MJS)) {
      return {
        ...block,
        languageOptions: {
          ...block.languageOptions,
          parserOptions: {
            ...block.languageOptions.parserOptions,
            projectService: {
              ...block.languageOptions.parserOptions.projectService,
              allowDefaultProject: [LOCAL_MJS, ...adp],
            },
          },
        },
      };
    }

    // disableTypeChecked block: the base lists only *.config.mjs, which misses
    // the bare-named vendored base; add *.mjs so it isn't type-checked.
    if (
      Array.isArray(block.files) &&
      block.files.includes("*.config.mjs") &&
      !block.files.includes(LOCAL_MJS)
    ) {
      return { ...block, files: [...block.files, LOCAL_MJS] };
    }

    return block;
  }),
];

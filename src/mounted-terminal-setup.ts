// Vitest setup: every terminal a test mounted through `mountTerminal` is
// destroyed after the test, so no case inherits a live terminal from the last.

import { afterEach } from "vitest";
import { destroyMounted } from "./test-helpers/mounted-registry.js";

afterEach(() => {
  destroyMounted();
});

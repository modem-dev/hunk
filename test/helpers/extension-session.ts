import { createExtensionSession } from "../../packages/hunk/src/extensions/session";
import { createEmptyExtensionLoadResult } from "../../packages/hunk/src/extensions/types";

/** Create an empty explicitly owned extension session for lifecycle tests. */
export function createTestExtensionSession(cwd = "/repo") {
  return createExtensionSession(createEmptyExtensionLoadResult(cwd), cwd);
}

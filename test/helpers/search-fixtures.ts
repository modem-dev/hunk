import type { ExtensionDiffFile } from "../../packages/hunk/src/extension-api/types";

/** Build a minimal reviewed-file view carrying real patch text for content search. */
export function createTestSearchFile(id: string, path: string, patch: string): ExtensionDiffFile {
  return {
    id,
    path,
    patch,
    stats: { additions: 0, deletions: 0 },
    metadata: {},
    agent: null,
  };
}

/** Two hunks: three `readConfig` matches in the first, none in the second. */
export const searchTestAlpha = createTestSearchFile(
  "file-0",
  "src/alpha.ts",
  [
    "diff --git a/src/alpha.ts b/src/alpha.ts",
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -10,3 +10,4 @@ function alpha() {",
    " const keep = 1;",
    "-const removed = readConfig();",
    "+const added = readConfig();",
    "+const second = readConfig();",
    "@@ -40,2 +41,2 @@",
    " untouched",
    "+const late = 2;",
  ].join("\n"),
);

/** One hunk with two occurrences per line on both sides. */
export const searchTestRepeated = createTestSearchFile(
  "file-repeated",
  "src/repeated.ts",
  ["@@ -1 +1 @@", "-readConfig(); readConfig();", "+readConfig(); readConfig();"].join("\n"),
);

/** One hunk with a single `readConfig` match. */
export const searchTestBeta = createTestSearchFile(
  "file-1",
  "src/beta.ts",
  ["@@ -1,2 +1,2 @@", " context", "+readConfig();"].join("\n"),
);

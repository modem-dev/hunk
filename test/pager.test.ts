import { describe, expect, test } from "bun:test";
import { looksLikePatchInput } from "../src/core/pager";

describe("general pager detection", () => {
  test("detects git-style patch input even when ANSI-colored", () => {
    const patch = [
      "\u001b[1mdiff --git a/src/example.ts b/src/example.ts\u001b[m",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1,2 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "+export const extra = true;",
    ].join("\n");

    expect(looksLikePatchInput(patch)).toBe(true);
  });

  test("does not misclassify plain git pager text as a patch", () => {
    const branchOutput = ["* main", "  feat/persist-view-config", "  release/0.1.0"].join("\n");

    expect(looksLikePatchInput(branchOutput)).toBe(false);
  });
});

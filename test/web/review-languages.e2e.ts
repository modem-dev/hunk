/**
 * Checks that files Hunk assigns a language to highlight in the browser as in the terminal.
 *
 * Pierre's own inference does not know `.mts` and `.cts`; Hunk registers them itself
 * (`core/documents/fileLanguage.ts`). The producer resolves each file's language with that
 * registry and the shared model carries it, so the page highlights them without registering
 * anything (audit A11).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  startTestWebReview,
  waitForTestCondition,
  watchTestPageProblems,
  type TestWebReview,
} from "./webTestHarness";

let review: TestWebReview | undefined;
let directory: string | undefined;

test.afterEach(async () => {
  await review?.stop();
  review = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

/** One added TypeScript module at `path`, as a patch. */
function addedModulePatch(path: string) {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,3 @@",
    "+export interface Greeting { name: string }",
    "+export const greet = (value: Greeting): string => `hi ${value.name}`;",
    "+export default greet;",
    "",
  ].join("\n");
}

test("highlights .mts and .cts files as TypeScript", async ({ page }) => {
  directory = mkdtempSync(join(tmpdir(), "hunk-web-languages-"));
  const patch = join(directory, "modules.patch");
  writeFileSync(patch, addedModulePatch("src/esm.mts") + addedModulePatch("src/cjs.cts"));
  review = await startTestWebReview(patch);
  const problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.getByTestId("file-count")).toHaveText("2 files");

  for (const index of [0, 1]) {
    await waitForTestCondition(
      `file ${index} to highlight as TypeScript`,
      () =>
        page.evaluate((position) => {
          const container = document
            .querySelectorAll("section[data-file-key]")
            [position]?.querySelector("diffs-container");
          const root = container?.shadowRoot;
          if (!root) return undefined;
          const colors = new Set(
            Array.from(
              root.querySelectorAll("span[style]"),
              (span) => getComputedStyle(span).color,
            ),
          );
          return colors.size > 2 ? true : undefined;
        }, index),
      30_000,
    );
  }
  expect(problems).toEqual([]);
});

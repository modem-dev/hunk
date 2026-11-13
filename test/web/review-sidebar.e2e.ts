/**
 * Checks the tree-mode sidebar against a review that lists two files at one path.
 *
 * The shared model allows it (a deletion and an addition of one path have different keys), and
 * Pierre's tree keys rows by path, so the sidebar gives each repeat a row of its own; every file
 * must stay reachable from the tree.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startTestWebReview, watchTestPageProblems, type TestWebReview } from "./webTestHarness";

let review: TestWebReview | undefined;
let directory: string | undefined;

test.afterEach(async () => {
  await review?.stop();
  review = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

/** A patch that deletes `path` and then adds it again, as two files of one review. */
function deleteThenAddPatch(path: string) {
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    "--- a/" + path,
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export const before = 1;",
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/" + path,
    "@@ -0,0 +1 @@",
    "+export const after = 2;",
    "",
  ].join("\n");
}

test("reaches both files that share one path from the tree", async ({ page }) => {
  directory = mkdtempSync(join(tmpdir(), "hunk-web-sidebar-"));
  const patch = join(directory, "same-path.patch");
  writeFileSync(patch, deleteThenAddPatch("src/same.ts"));
  review = await startTestWebReview(patch);
  const problems = await watchTestPageProblems(page);
  await page.addInitScript(() =>
    window.localStorage.setItem("hunk.review.view", '{"sidebarMode":"tree","sidebarOpen":true}'),
  );
  await page.goto(review.url);
  await expect(page.getByTestId("file-count")).toHaveText("2 files");
  await expect(page.locator("section[data-file-key]")).toHaveCount(2);
  const keys = await page
    .locator("section[data-file-key]")
    .evaluateAll((sections) => sections.map((section) => section.getAttribute("data-file-key")));
  expect(keys).toHaveLength(2);

  const rows = page.locator('file-tree-container [data-item-type="file"]');
  await expect(rows).toHaveCount(2);
  await rows.nth(1).click();
  await expect(page.locator("section[data-selected]")).toHaveAttribute("data-file-key", keys[1]!);
  await rows.nth(0).click();
  await expect(page.locator("section[data-selected]")).toHaveAttribute("data-file-key", keys[0]!);
  expect(problems).toEqual([]);
});

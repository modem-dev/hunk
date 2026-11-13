/**
 * Keeps a 2,000-file review responsive: it loads, mounts only what is near the viewport,
 * and jumps from the sidebar to the last file quickly.
 */
import { expect, test } from "@playwright/test";
import { startTestWebReview, watchTestPageProblems, type TestWebReview } from "./webTestHarness";

const FILE_COUNT = 2_000;

let review: TestWebReview | undefined;

test.afterEach(async () => {
  await review?.stop();
  review = undefined;
});

test("stays responsive with 2,000 files", async ({ page }) => {
  test.setTimeout(180_000);
  review = await startTestWebReview(`--many=${FILE_COUNT}`);
  const problems = await watchTestPageProblems(page);
  await page.addInitScript(() =>
    window.localStorage.setItem("hunk.review.view", '{"sidebarMode":"flat"}'),
  );

  await page.goto(review.url);
  await expect(page.getByTestId("file-count")).toHaveText(`${FILE_COUNT} files`, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 120_000 });

  // Only files near the viewport carry a Pierre diff.
  const mounted = await page.locator("section[data-file-key] diffs-container").count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(100);

  const started = Date.now();
  await page.locator(".flat-file", { hasText: "file-1999.ts" }).click();
  await expect(
    page.locator("section[data-file-key]").last().locator("diffs-container"),
  ).toHaveCount(1, { timeout: 10_000 });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(problems).toEqual([]);
});

/**
 * Checks image previews across a reload that removes one side of an image.
 *
 * A changed image shows both sides; when a refresh turns it into a deletion, the added side's
 * resource is gone and the preview must show the remaining side, not an `<img>` pointing at
 * a blob URL the previous side already revoked.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startTestWebReview, watchTestPageProblems, type TestWebReview } from "./webTestHarness";

let review: TestWebReview | undefined;
let problems: string[] = [];

test.use({ viewport: { width: 1440, height: 900 } });

test.afterEach(async () => {
  try {
    expect(problems).toEqual([]);
  } finally {
    await review?.stop();
    review = undefined;
  }
});

test("shows the remaining side when a reload removes one side of an image", async ({ page }) => {
  review = await startTestWebReview("--previews");
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
  const photo = page.locator('section[aria-label="images/photo.png"]');
  await expect(photo.getByTestId("image-preview").locator("figcaption")).toHaveCount(2);

  execFileSync("git", ["rm", "-f", "-q", join("images", "photo.png")], {
    cwd: review.repo!,
    stdio: "ignore",
  });
  await page.getByTestId("refresh").click();

  const preview = photo.getByTestId("image-preview");
  await expect(preview.locator("figcaption")).toHaveCount(1, { timeout: 30_000 });
  await expect(preview.locator("figcaption")).toHaveText(/^Deleted · /);
  // Every image shown decoded: none points at a revoked blob.
  await expect
    .poll(() =>
      preview.locator("img").evaluateAll((images) =>
        images.every((image) => {
          const loaded = image as HTMLImageElement;
          return loaded.complete && loaded.naturalWidth > 0;
        }),
      ),
    )
    .toBe(true);
  await expect(preview.locator("img")).toHaveCount(1);
});

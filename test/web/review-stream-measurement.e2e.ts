/**
 * Checks that the stream's measured heights never outlive the layout they were measured in.
 *
 * Files measured while mounted keep their height once they scroll away. A layout switch
 * reflows every file, so those heights must be dropped in the same render, or the scrollbar
 * keeps the old layout's heights while the minimap (which reads fresh estimates) disagrees.
 */
import { expect, test, type Page } from "@playwright/test";
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

/** How far the minimap's projected stream height is from the stream's real height. */
function minimapHeightDrift(page: Page) {
  return page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    const minimap = document.querySelector<HTMLElement>('[data-testid="minimap"]')!;
    return Number(minimap.dataset.streamHeight) - stream.scrollHeight;
  });
}

test("drops measured heights in the render that switches layout", async ({ page }) => {
  review = await startTestWebReview("--rich");
  problems = await watchTestPageProblems(page);
  const open = async () => {
    await page.goto(review!.url);
    await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("minimap")).toBeVisible();
  };
  await open();
  await page.getByTestId("layout-split").click();
  await expect(page.locator(".review-app")).toHaveAttribute("data-layout", "split");

  // Scroll through the whole stream so files are measured, then back to the top so most of
  // them are unmounted and hold only their remembered height.
  const stream = page.locator(".review-stream");
  for (let step = 0; step < 12; step += 1) {
    await stream.evaluate((element, fraction) => {
      element.scrollTop = element.scrollHeight * fraction;
    }, step / 11);
    await page.waitForTimeout(150);
  }
  await stream.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(500);

  await page.getByTestId("layout-unified").click();
  await expect(page.locator(".review-app")).toHaveAttribute("data-layout", "unified");
  await page.waitForTimeout(500);
  const switched = await minimapHeightDrift(page);

  // A page that never measured anything in the split layout is the reference: after the
  // switch the stream and minimap must disagree exactly as much as they do there.
  await open();
  await expect(page.locator(".review-app")).toHaveAttribute("data-layout", "unified");
  await page.waitForTimeout(500);
  expect(Math.abs(switched - (await minimapHeightDrift(page)))).toBeLessThanOrEqual(2);
});

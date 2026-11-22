/**
 * Checks that the page starts from the session's presentation defaults the way the terminal
 * does: `--no-sidebar` keeps the files sidebar closed on a wide viewport, and `theme = "auto"`
 * follows the browser's color scheme while an explicit theme and a per-browser theme
 * choice still win.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  chooseTestTheme,
  PATCH_FIXTURE,
  startTestWebReview,
  watchTestPageProblems,
  type TestWebReview,
  type TestWebReviewOptions,
} from "./webTestHarness";

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

/** Open the fixture review and wait until the page is connected. */
async function openTestReview(page: Page, options: TestWebReviewOptions = {}) {
  review = await startTestWebReview(PATCH_FIXTURE, options);
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
}

/** The appearance the page applied to its root. */
function appliedAppearance(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.themeAppearance);
}

test("opens the sidebar by default on a wide viewport", async ({ page }) => {
  await openTestReview(page);
  await expect(page.getByRole("navigation", { name: "Files sidebar" })).toBeVisible();
});

test("keeps the sidebar closed with --no-sidebar", async ({ page }) => {
  await openTestReview(page, { args: ["--no-sidebar"] });
  await expect(page.getByTestId("file-count")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Files sidebar" })).toHaveCount(0);
});

test.describe("with a light color scheme", () => {
  test.use({ colorScheme: "light" });

  // The terminal's own default (no `theme` configured) is GitHub dark, not `auto`.
  test("an unset theme stays on the terminal's default, GitHub dark", async ({ page }) => {
    await openTestReview(page);
    await expect.poll(() => appliedAppearance(page)).toBe("dark");
  });

  test("theme = auto follows the browser's light scheme", async ({ page }) => {
    await openTestReview(page, { config: 'theme = "auto"\n' });
    await expect.poll(() => appliedAppearance(page)).toBe("light");
  });

  test("an explicit theme wins over the color scheme", async ({ page }) => {
    await openTestReview(page, { args: ["--theme", "github-dark-default"] });
    await expect.poll(() => appliedAppearance(page)).toBe("dark");
  });

  test("this browser's theme choice wins over an auto theme", async ({ page }) => {
    await openTestReview(page, { config: 'theme = "auto"\n' });
    await expect.poll(() => appliedAppearance(page)).toBe("light");
    await chooseTestTheme(page, "github-dark-default");
    await expect.poll(() => appliedAppearance(page)).toBe("dark");
  });
});

test.describe("with a dark color scheme", () => {
  test.use({ colorScheme: "dark" });

  test("theme = auto follows the browser's dark scheme", async ({ page }) => {
    await openTestReview(page, { config: 'theme = "auto"\n' });
    await expect.poll(() => appliedAppearance(page)).toBe("dark");
  });
});

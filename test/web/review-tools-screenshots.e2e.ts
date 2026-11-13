/**
 * Captures the side panel's review tools for visual review.
 *
 * Opt-in: runs only when `HUNK_WEB_TOOL_SCREENSHOT_DIR` names a directory, and writes one PNG
 * per state there at device scale 2. Not an assertion suite — `review-tools.e2e.ts` is.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { chooseTestTheme, startTestWebReview, type TestWebReview } from "./webTestHarness";

const OUTPUT = process.env.HUNK_WEB_TOOL_SCREENSHOT_DIR;

test.skip(!OUTPUT, "Set HUNK_WEB_TOOL_SCREENSHOT_DIR to capture tool screenshots.");
test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

let review: TestWebReview | undefined;

test.afterEach(async () => {
  await review?.stop();
  review = undefined;
});

/** Save one capture once lazy work has settled. */
async function capture(page: Page, name: string) {
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: join(OUTPUT!, `${name}.png`) });
}

/** Open the rich review with agent notes and a stored theme. */
async function openRich(page: Page, themeId: string) {
  await page.addInitScript((theme) => {
    window.localStorage.setItem("hunk.review.theme", theme);
  }, themeId);
  await page.goto(review!.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

test("captures the overview tab", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(OUTPUT!, { recursive: true });
  review = await startTestWebReview("--rich", {
    args: ["--agent-notes"],
    context: {
      "src/app/main.ts": {
        summary: "Raises the threshold.",
        annotations: [{ newRange: [13, 13], summary: "Threshold raised.", author: "sonnet" }],
      },
    },
  });
  await review.hunk([
    "session",
    "comment",
    "add",
    review.sessionId,
    "--file",
    "src/app/main.ts",
    "--new-line",
    "46",
    "--summary",
    "Consider a shared formatter.",
  ]);

  await openRich(page, "github-dark-default");
  await page.locator(".overview-disclosure[aria-expanded]").first().click();
  await capture(page, "overview-dark-1440");
  await page.locator(".side-panel-body").evaluate((element) => (element.scrollTop = 10_000));
  await capture(page, "overview-dark-1440-lower");

  await chooseTestTheme(page, "github-light-default");
  await page.locator(".side-panel-body").evaluate((element) => (element.scrollTop = 0));
  await capture(page, "overview-light-1440");

  await page.setViewportSize({ width: 1100, height: 800 });
  if ((await page.getByTestId("side-panel").count()) === 0) {
    await page.getByTestId("toggle-side-panel").click();
  }
  await capture(page, "overview-light-1100");
});

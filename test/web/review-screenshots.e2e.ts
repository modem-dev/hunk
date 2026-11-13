/**
 * Captures the review page in the states a reviewer judges fidelity by.
 *
 * Opt-in: runs only when `HUNK_WEB_SCREENSHOT_DIR` names a directory, and writes one PNG per
 * state there at device scale 2. Not an assertion suite — the other `*.e2e.ts` files are.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { chooseTestTheme, startTestWebReview, type TestWebReview } from "./webTestHarness";

const OUTPUT = process.env.HUNK_WEB_SCREENSHOT_DIR;

test.skip(!OUTPUT, "Set HUNK_WEB_SCREENSHOT_DIR to capture screenshots.");
test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

let review: TestWebReview | undefined;

test.afterEach(async () => {
  await review?.stop();
  review = undefined;
});

/** Let lazy grammars, themes, and mounts settle before a capture. */
async function settle(page: Page) {
  await page.waitForTimeout(1_200);
}

/** Save one capture. */
async function capture(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: join(OUTPUT!, `${name}.png`) });
}

/** Open the rich review with a stored theme and layout already chosen. */
async function openRich(page: Page, themeId: string, layout: "split" | "unified" | "auto") {
  await page.addInitScript(
    ([theme, view]) => {
      window.localStorage.setItem("hunk.review.theme", theme);
      window.localStorage.setItem("hunk.review.view", view);
    },
    [themeId, JSON.stringify({ layout })] as const,
  );
  await page.goto(review!.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
}

test("captures the review page for visual review", async ({ page, browser }) => {
  test.setTimeout(240_000);
  mkdirSync(OUTPUT!, { recursive: true });
  review = await startTestWebReview("--rich");

  await openRich(page, "github-dark-default", "split");
  await capture(page, "01-split-github-dark");
  await page.getByTestId("layout-unified").click();
  await capture(page, "02-unified-github-dark");

  const gap = page.locator(".gap-separator").first();
  await gap.click();
  await page
    .locator('.gap-separator[data-gap-state="loading"]')
    .waitFor({ state: "detached" })
    .catch(() => undefined);
  await capture(page, "03-expanded-gap");

  // The second hunk of the first file selected from the keyboard: the accent rail, revealed
  // under the sticky header.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("]");
  await capture(page, "10-selected-hunk-mid-file");

  await chooseTestTheme(page, "github-light-default");
  await page.getByTestId("layout-split").click();
  await capture(page, "04-split-github-light");
  await settle(page);
  await page.screenshot({
    path: join(OUTPUT!, "11-toolbar-light.png"),
    clip: { x: 0, y: 0, width: 1440, height: 48 },
  });
  await page.getByTestId("theme-picker").click();
  await page.screenshot({
    path: join(OUTPUT!, "12-theme-menu-light.png"),
    clip: { x: 840, y: 0, width: 600, height: 520 },
  });
  await page.keyboard.press("Escape");
  await chooseTestTheme(page, "dracula");
  await capture(page, "05-split-dracula");
  await chooseTestTheme(page, "solarized-light");
  await capture(page, "06-split-solarized-light");

  await page
    .locator('section[data-file-key]:has([data-empty-reason="binary"])')
    .scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    const section = document.querySelector<HTMLElement>(
      'section[data-file-key]:has([data-empty-reason="rename-only"])',
    )!;
    stream.scrollTop = section.offsetTop - 120;
  });
  await capture(page, "07-placeholders");

  await page.getByTestId("toggle-sidebar").click();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".review-stream")!.scrollTop = 0;
  });
  await capture(page, "08-sidebar-collapsed");

  const narrow = await browser.newPage({
    deviceScaleFactor: 2,
    viewport: { width: 800, height: 900 },
  });
  await narrow.addInitScript(() =>
    window.localStorage.setItem("hunk.review.theme", "github-dark-default"),
  );
  await narrow.goto(review.url);
  await expect(narrow.locator('.toolbar [data-state="connected"]')).toBeVisible({
    timeout: 30_000,
  });
  await capture(narrow, "09-narrow-800");
  await narrow.close();
});

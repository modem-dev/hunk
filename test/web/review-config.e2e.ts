/**
 * Checks that the config options the host publishes as view defaults reach a fresh browser:
 * `tab_width` sets the tab stops Pierre draws code with, `auto_split_min_width` moves the
 * width at which `auto` layout switches between split and unified, and `sidebar` decides
 * whether the files sidebar starts open. A fresh browser context has no stored choice, so the
 * session's values are what apply. Every step passes without a CSP violation or console error.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  PATCH_FIXTURE,
  startTestWebReview,
  waitForTestCondition,
  watchTestPageProblems,
  type TestWebReview,
} from "./webTestHarness";

let review: TestWebReview | undefined;
let problems: string[] = [];

test.afterEach(async () => {
  try {
    expect(problems).toEqual([]);
  } finally {
    await review?.stop();
    review = undefined;
  }
});

/** Open the patch review with one user config and wait until its diffs have rendered. */
async function openTestConfiguredReview(page: Page, config: string) {
  review = await startTestWebReview(PATCH_FIXTURE, { config });
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("file-count")).toHaveText("2 files");
}

/** The computed `tab-size` of the first file's code column, inside Pierre's shadow root. */
function codeTabSize(page: Page) {
  return waitForTestCondition(
    "Pierre to render the first diff's code column",
    () =>
      page.evaluate(() => {
        const container = document.querySelector("section[data-file-key] diffs-container");
        const code = container?.shadowRoot?.querySelector("[data-code]");
        return code ? getComputedStyle(code).tabSize : undefined;
      }),
    30_000,
  );
}

test("applies tab width, the auto-split width, and a closed sidebar from config", async ({
  page,
}) => {
  // 1440px is wide enough for the page to open the sidebar by itself, so a closed one is the
  // config's doing.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTestConfiguredReview(
    page,
    ['mode = "auto"', "tab_width = 8", "auto_split_min_width = 100", "sidebar = false", ""].join(
      "\n",
    ),
  );

  const state = (await review!.readApi("state")).state as {
    presentation: { view: Record<string, unknown> };
  };
  expect(state.presentation.view).toMatchObject({
    layout: "auto",
    tabWidth: 8,
    autoSplitMinWidth: 100,
    sidebar: false,
  });

  expect(await codeTabSize(page)).toBe("8");
  await expect(page.locator("nav.sidebar")).toHaveCount(0);
  await expect(page.getByTestId("toggle-sidebar")).toHaveAttribute("aria-pressed", "false");

  // 600px is unified under either threshold. 1000px leaves the diff area roughly 120
  // monospace columns: unified under the built-in threshold of 160, split under the configured
  // 100. Narrowing first makes the switch back to split something the page must do itself.
  const app = page.locator(".review-app");
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(app).toHaveAttribute("data-layout", "unified");
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(app).toHaveAttribute("data-layout", "split");
});

// Intent: without config the page starts where the terminal's built-in defaults would: tab
// stops of 4 rather than Pierre's 2, unified below 160 columns, and the sidebar left to the
// viewport. `sidebar = true` opens it even on a viewport too narrow to open it by itself.
test("starts from the terminal's defaults, and opens the sidebar when config says so", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openTestConfiguredReview(page, 'mode = "auto"\n');

  expect(await codeTabSize(page)).toBe("4");
  await expect(page.locator(".review-app")).toHaveAttribute("data-layout", "unified");
  await expect(page.locator("nav.sidebar")).toHaveCount(0);
  await review!.stop();
  review = undefined;
  expect(problems).toEqual([]);

  const fresh = await page
    .context()
    .browser()!
    .newContext({
      viewport: { width: 1000, height: 800 },
    });
  const freshPage = await fresh.newPage();
  try {
    await openTestConfiguredReview(freshPage, "sidebar = true\n");
    await expect(freshPage.locator("nav.sidebar")).toHaveCount(1);
    await expect(freshPage.getByTestId("toggle-sidebar")).toHaveAttribute("aria-pressed", "true");
  } finally {
    await fresh.close();
  }
});

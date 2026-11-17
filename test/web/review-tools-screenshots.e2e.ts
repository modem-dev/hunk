/**
 * Captures the side panel's review tools for visual review.
 *
 * Opt-in: runs only when `HUNK_WEB_TOOL_SCREENSHOT_DIR` names a directory, and writes one PNG
 * per state there at device scale 2. Not an assertion suite — `review-tools.e2e.ts` is.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  chooseTestTheme,
  openTestViewMenu,
  seedTestOpenSidePanel,
  startTestWebReview,
  type TestWebReview,
} from "./webTestHarness";

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

/** Flip "Hide viewed" from the View menu and close the menu before the next capture. */
async function toggleTestHideViewed(page: Page) {
  await openTestViewMenu(page);
  await page.getByRole("menuitemcheckbox", { name: "Hide viewed" }).click();
  await page.keyboard.press("Escape");
}

/** Open the rich review with agent notes and a stored theme. */
async function openRich(page: Page, themeId: string) {
  // The panel starts closed; these captures show its tools unless a test stored a choice first.
  await seedTestOpenSidePanel(page, "overview");
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

  const reply = await review.hunk([
    "session",
    "comment",
    "add",
    review.sessionId,
    "--file",
    "src/gen/module-12.ts",
    "--new-line",
    "1",
    "--summary",
    "This module's rename should land with its callers.",
    "--json",
  ]);
  const replyTo = (JSON.parse(reply) as { result: { commentId: string } }).result.commentId;
  await review.hunk([
    "session",
    "comment",
    "add",
    review.sessionId,
    "--reply-to",
    replyTo,
    "--summary",
    "Agreed; doing that in the follow-up.",
  ]);

  await openRich(page, "github-dark-default");
  await page.locator(".overview-disclosure[aria-expanded]").first().click();
  await capture(page, "overview-dark-1440");
  await page.locator(".side-panel-body").evaluate((element) => (element.scrollTop = 10_000));
  await capture(page, "overview-dark-1440-lower");

  await chooseTestTheme(page, "github-light-default");
  await page.locator(".side-panel-body").evaluate((element) => (element.scrollTop = 0));
  await capture(page, "overview-light-1440");

  await page.getByTestId("side-panel-tab-notes").click();
  await page.getByRole("button", { name: "1 reply" }).click();
  await page.getByTestId("notes-row").filter({ hasText: "rename should land" }).click();
  await capture(page, "notes-light-1440");
  await chooseTestTheme(page, "github-dark-default");
  await capture(page, "notes-dark-1440");
  await page.getByTestId("side-panel-tab-overview").click();
  await chooseTestTheme(page, "github-light-default");

  await page.setViewportSize({ width: 1100, height: 800 });
  if ((await page.getByTestId("side-panel").count()) === 0) {
    await page.getByTestId("toggle-side-panel").click();
  }
  await capture(page, "overview-light-1100");
});

test("captures the minimap on a long review", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(OUTPUT!, { recursive: true });
  review = await startTestWebReview("--rich", { args: ["--agent-notes"] });
  for (const [file, line] of [
    ["src/gen/module-05.ts", "1"],
    ["src/gen/module-22.ts", "1"],
    ["src/gen/module-31.ts", "1"],
  ] as const) {
    await review.hunk([
      "session",
      "comment",
      "add",
      review.sessionId,
      "--file",
      file,
      "--new-line",
      line,
      "--summary",
      `A note on ${file}`,
    ]);
  }
  await review.hunk([
    "session",
    "highlight",
    "add",
    review.sessionId,
    "--file",
    "src/app/main.ts",
    "--new-line",
    "13",
    "--start",
    "0",
    "--end",
    "6",
  ]);
  await page.addInitScript(() =>
    window.localStorage.setItem("hunk.review.panel", JSON.stringify({ open: false })),
  );
  await openRich(page, "github-dark-default");
  await page.locator(".review-stream").evaluate((element) => (element.scrollTop = 2_400));
  await capture(page, "minimap-dark-1440");
  await chooseTestTheme(page, "github-light-default");
  await capture(page, "minimap-light-1440");
});

test("captures the image previews and rendered Markdown", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(OUTPUT!, { recursive: true });
  review = await startTestWebReview("--previews");
  await page.addInitScript(() =>
    window.localStorage.setItem("hunk.review.panel", JSON.stringify({ open: false })),
  );
  await openRich(page, "github-dark-default");
  const photo = page.locator('section[aria-label="images/photo.png"]');
  await expect(photo.getByTestId("image-preview")).toBeVisible();
  await capture(page, "image-side-by-side-dark");
  await photo.getByTestId("image-mode-swipe").click();
  await photo.getByTestId("image-slider").fill("35");
  await capture(page, "image-swipe-dark");
  await photo.getByTestId("image-mode-onion").click();
  await photo.getByTestId("image-slider").fill("55");
  await capture(page, "image-onion-dark");
  await page.locator('section[aria-label="images/added.png"]').scrollIntoViewIfNeeded();
  await capture(page, "image-added-deleted-dark");

  const guide = page.locator('section[aria-label="docs/guide.md"]');
  await guide.getByTestId("markdown-mode-rendered").click();
  await guide.evaluate((element) => element.scrollIntoView());
  await capture(page, "markdown-rendered-dark");
  await chooseTestTheme(page, "github-light-default");
  await capture(page, "markdown-rendered-light");
});

test("captures viewed files: marked, collapsed, changed since viewed, and hidden", async ({
  page,
}) => {
  test.setTimeout(240_000);
  mkdirSync(OUTPUT!, { recursive: true });
  review = await startTestWebReview("--rich");
  await openRich(page, "github-dark-default");
  await page.getByRole("radio", { name: "Flat" }).click();
  for (const path of ["src/app/main.ts", "src/app/renamed-new.ts"]) {
    await page.locator(`section[aria-label="${path}"] .viewed-toggle input`).click();
  }
  await expect(page.getByTestId("viewed-progress")).toHaveText(/^2 of/);
  await capture(page, "viewed-collapsed-dark");

  await review.reload();
  await expect(page.locator('section[aria-label="src/app/main.ts"] .viewed-changed')).toBeVisible({
    timeout: 30_000,
  });
  await capture(page, "viewed-changed-dark");
  await page.getByRole("radio", { name: "Tree" }).click();
  await capture(page, "viewed-changed-tree-dark");
  await page.getByRole("radio", { name: "Flat" }).click();

  await toggleTestHideViewed(page);
  await capture(page, "viewed-hidden-dark");
  await chooseTestTheme(page, "github-light-default");
  await toggleTestHideViewed(page);
  await capture(page, "viewed-light");
  await page.getByRole("radio", { name: "Tree" }).click();
  await capture(page, "viewed-tree-light");
});

/** Open one scenario with a stored theme and the panel's default (closed) state. */
async function openSummaryScenario(page: Page, input: string, themeId: string) {
  review = await startTestWebReview(input);
  await page.addInitScript((theme) => {
    window.localStorage.setItem("hunk.review.theme", theme);
  }, themeId);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("summary-strip")).toHaveAttribute("data-state", "ready");
}

test("captures the summary strip with the panel closed and open", async ({ page }) => {
  test.setTimeout(300_000);
  mkdirSync(OUTPUT!, { recursive: true });
  for (const [scenario, input] of [
    ["rich", "--rich"],
    ["previews", "--previews"],
  ] as const) {
    for (const [tone, themeId] of [
      ["dark", "github-dark-default"],
      ["light", "github-light-default"],
    ] as const) {
      await openSummaryScenario(page, input, themeId);
      for (const width of [1440, 800]) {
        await page.setViewportSize({ width, height: 900 });
        await capture(page, `summary-${scenario}-${tone}-${width}-closed`);
        await page.getByTestId("summary-overview").click();
        await expect(page.getByTestId("side-panel")).toBeVisible();
        await capture(page, `summary-${scenario}-${tone}-${width}-open`);
        await page.getByTestId("toggle-side-panel").click();
        await expect(page.getByTestId("side-panel")).toHaveCount(0);
      }
      await review?.stop();
      review = undefined;
      await page.evaluate(() => window.localStorage.removeItem("hunk.review.panel"));
    }
  }
});

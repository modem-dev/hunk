/**
 * Drives the side panel's review tools against a rich live review.
 *
 * The Overview tab's figures must match the toolbar and the shared overview selector's policy,
 * and every row naming a file or a directory must jump the stream there. The panel opens by
 * default on wide viewports, toggles from the toolbar and its web-only shortcut, remembers its
 * state per browser, and passes axe — all without a CSP violation or console error.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  startTestWebReview,
  watchTestPageProblems,
  type TestWebReview,
  type TestWebReviewOptions,
} from "./webTestHarness";

let review: TestWebReview | undefined;
let problems: string[] = [];

test.use({ viewport: { width: 1440, height: 900 } });

test.afterEach(async () => {
  expect(problems).toEqual([]);
  await review?.stop();
  review = undefined;
});

/** Open the rich review and wait until every file has loaded. */
async function openTestReview(page: Page, options: TestWebReviewOptions = {}) {
  review = await startTestWebReview("--rich", options);
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** The file key of the stream's selected section. */
function selectedSectionPath(page: Page) {
  return page.locator("section[data-selected] .file-name").first();
}

test("opens the overview by default on a wide viewport and agrees with the toolbar", async ({
  page,
}) => {
  await openTestReview(page);
  const panel = page.getByTestId("side-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const files = await page.getByTestId("file-count").textContent();
  await expect(page.getByTestId("overview-total")).toContainText(files!);
  const added = await page.locator(".toolbar .stat-added").textContent();
  const removed = await page.locator(".toolbar .stat-removed").textContent();
  await expect(page.getByTestId("overview-total").locator(".stat-added")).toHaveText(added!);
  await expect(page.getByTestId("overview-total").locator(".stat-removed")).toHaveText(
    removed!.replace("-", "−"),
  );
  // The rich review is 47 files with forty small generated-module edits; its size is stated.
  await expect(panel.locator(".overview-size-letter")).toHaveText(/^(XS|S|M|L|XL)$/);
});

test("jumps to a file from the largest-files list and to a directory's first file", async ({
  page,
}) => {
  await openTestReview(page);
  const panel = page.getByTestId("side-panel");

  const largest = panel.locator(".overview-list .overview-name").nth(1);
  const path = (await largest.textContent())!;
  await largest.click();
  await expect(selectedSectionPath(page)).toContainText(path.split("/").at(-1)!);
  const section = page.locator("section[data-selected]");
  await expect(section).toBeInViewport();

  const directory = panel.locator(".overview-tree .overview-name", { hasText: "src/" }).first();
  await directory.click();
  await expect(page.locator("section[data-selected]")).toBeInViewport();
  await expect(selectedSectionPath(page)).toBeVisible();
});

test("toggles from the toolbar and its shortcut, and remembers the choice", async ({ page }) => {
  await openTestReview(page);
  const panel = page.getByTestId("side-panel");
  await expect(panel).toBeVisible();

  await page.getByTestId("toggle-side-panel").click();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveCount(0);

  await page.locator(".review-stream").focus();
  await page.keyboard.press("p");
  await expect(panel).toBeVisible();
  await page.keyboard.press("p");
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("Shift+O");
  await expect(panel).toBeVisible();
});

test("starts hidden on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTestReview(page);
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await page.getByTestId("toggle-side-panel").click();
  await expect(page.getByTestId("side-panel")).toBeVisible();
});

test("counts notes by origin in the overview", async ({ page }) => {
  await openTestReview(page, {
    args: ["--agent-notes"],
    context: {
      "src/app/main.ts": {
        annotations: [{ newRange: [13, 13], summary: "Sidecar note", author: "sonnet" }],
      },
    },
  });
  const notes = page.getByTestId("overview-notes");
  await expect(notes).toBeVisible();
  const row = notes.locator("tbody tr", { hasText: "src/app/main.ts" });
  await expect(row.locator("td").first()).toHaveText("1");
  await row.getByRole("button").click();
  await expect(selectedSectionPath(page)).toContainText("main.ts");
});

test("has no serious accessibility violations with the panel open", async ({ page }) => {
  await openTestReview(page);
  await expect(page.getByTestId("side-panel")).toBeVisible();
  await page.locator(".overview-disclosure[aria-expanded]").first().click();
  const results = await new AxeBuilder({ page })
    .exclude("diffs-container")
    .exclude("file-tree-container")
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`,
    );
  expect(serious).toEqual([]);
});

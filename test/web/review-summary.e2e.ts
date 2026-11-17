/**
 * Drives the summary strip above the review and the side panel that starts closed.
 *
 * The strip is one non-scrolling line: the size badge, a sentence when the changeset is mostly
 * one file or one directory, quiet role counts that never touch the shared filter, and an
 * Overview button that opens the panel. Its figures must agree with the toolbar, it must say
 * so when the shared filter is active, and it must not move the stream's geometry.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  PATCH_FIXTURE,
  seedTestOpenSidePanel,
  startTestWebReview,
  watchTestPageProblems,
  type TestWebReview,
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

/** Open one scenario's review and wait until every file has loaded. */
async function openTestReview(page: Page, input = "--rich") {
  review = await startTestWebReview(input);
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** A number as the page prints it, without grouping or signs. */
function plainNumber(text: string) {
  return Number(text.replace(/[^0-9]/g, ""));
}

test("names the file that dominates the review, with exact leftovers", async ({ page }) => {
  await openTestReview(page);
  const strip = page.getByTestId("summary-strip");
  await expect(strip).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("summary-size")).toHaveText(/^(XS|S|M|L|XL)$/);
  await expect(page.getByTestId("summary-size")).toHaveAttribute(
    "title",
    /meaningful changed lines/,
  );

  const text = page.getByTestId("summary-text");
  await expect(text.locator("code")).toHaveText("data/huge.json");
  await expect(text).toContainText("Without it:");

  // The figures are exact: the file's lines plus the rest are the toolbar's totals.
  const added = text.locator(".stat-added");
  const removed = text.locator(".stat-removed");
  const toolbarAdded = plainNumber((await page.locator(".toolbar .stat-added").textContent())!);
  const toolbarRemoved = plainNumber((await page.locator(".toolbar .stat-removed").textContent())!);
  expect(
    plainNumber((await added.nth(0).textContent())!) +
      plainNumber((await added.nth(1).textContent())!),
  ).toBe(toolbarAdded);
  expect(
    plainNumber((await removed.nth(0).textContent())!) +
      plainNumber((await removed.nth(1).textContent())!),
  ).toBe(toolbarRemoved);
  const totalFiles = plainNumber((await page.getByTestId("file-count").textContent())!);
  await expect(text).toContainText(`Without it: ${totalFiles - 1} files`);
});

test("shows non-zero role counts that are labels, not filters", async ({ page }) => {
  await openTestReview(page);
  const roles = page.getByTestId("summary-roles");
  await expect(roles.locator(".file-chip").first()).toBeVisible();
  await expect(roles.locator(".file-chip", { hasText: /\bsource$/ })).toHaveCount(1);
  expect(await roles.getByRole("button").count()).toBe(0);

  // Clicking a count changes nothing, least of all the filter shared with the terminal.
  await roles.locator(".file-chip").first().click();
  await expect(page.getByTestId("filter-input")).toHaveValue("");
  await expect(page.getByTestId("shared-filter")).toHaveCount(0);
});

test("says when the shared filter is active and counts the filtered files", async ({ page }) => {
  await openTestReview(page);
  const total = plainNumber((await page.getByTestId("file-count").textContent())!);
  await page.getByTestId("filter-input").fill("module-1");
  await expect(page.getByTestId("file-count")).toHaveText("10 files");
  await expect(page.getByTestId("summary-filter")).toContainText(`10 of ${total} files`);
  // Ten files in one directory is no "mostly in" (it needs two directories), and the filtered
  // set no longer has a dominant file: the strip says only that it is filtered.
  await expect(page.getByTestId("summary-text").locator("code")).toHaveCount(0);
  await page.getByTestId("filter-input").fill("");
  await expect(page.getByTestId("summary-filter")).toHaveCount(0);
});

test("leaves the stream's geometry alone: a fixed strip above it that does not scroll", async ({
  page,
}) => {
  await openTestReview(page);
  const strip = page.getByTestId("summary-strip");
  const box = (await strip.boundingBox())!;
  expect(box.height).toBe(40);
  const stream = page.getByTestId("review-stream");
  const streamBox = (await stream.boundingBox())!;
  expect(Math.round(streamBox.y)).toBe(Math.round(box.y + box.height));

  await stream.evaluate((element) => (element.scrollTop = 1_500));
  expect(Math.round((await strip.boundingBox())!.y)).toBe(Math.round(box.y));
  // The first section still starts at the stream's top, so the minimap's offsets hold.
  await stream.evaluate((element) => (element.scrollTop = 0));
  const first = (await page.locator("section[data-file-key]").first().boundingBox())!;
  expect(Math.round(first.y)).toBe(Math.round(streamBox.y));
});

test("opens the side panel on Overview, over a stored Notes choice", async ({ page }) => {
  review = await startTestWebReview("--rich");
  problems = await watchTestPageProblems(page);
  await seedTestOpenSidePanel(page, "notes");
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("summary-overview").click();
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("opens the panel from the closed default and keeps the toggle's hint", async ({ page }) => {
  await openTestReview(page);
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await page.getByTestId("summary-overview").click();
  await expect(page.getByTestId("side-panel")).toBeVisible();
  await expect(page.getByTestId("overview")).toBeVisible();
  await expect(page.getByTestId("toggle-side-panel")).toHaveAttribute("aria-pressed", "true");
});

test("names the directory that holds most of the files", async ({ page }) => {
  await openTestReview(page, "--previews");
  const text = page.getByTestId("summary-text");
  await expect(text.locator("code")).toHaveText("images/");
  await expect(text).toContainText(": 7 of 9 files.");
});

test("says nothing when no file or directory dominates", async ({ page }) => {
  await openTestReview(page, PATCH_FIXTURE);
  await expect(page.getByTestId("summary-size")).toBeVisible();
  await expect(page.getByTestId("summary-text")).toHaveText("");
});

test("drops the role counts first at 800px and keeps the badge and the button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await openTestReview(page);
  await expect(page.getByTestId("summary-roles")).toBeHidden();
  await expect(page.getByTestId("summary-size")).toBeVisible();
  await expect(page.getByTestId("summary-overview")).toBeVisible();
  const text = page.getByTestId("summary-text");
  await expect(text).toBeVisible();
  const overflow = await text.evaluate((element) => ({
    clipped: element.scrollWidth > element.clientWidth,
    ellipsis: getComputedStyle(element).textOverflow,
    height: element.parentElement!.getBoundingClientRect().height,
  }));
  expect(overflow.ellipsis).toBe("ellipsis");
  expect(overflow.height).toBe(40);
});

test("the Overview tab leaves out empty rows and says what Meaningful excludes", async ({
  page,
}) => {
  review = await startTestWebReview("--rich");
  problems = await watchTestPageProblems(page);
  await seedTestOpenSidePanel(page, "overview");
  await page.goto(review.url);
  await expect(page.getByTestId("overview")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });

  await expect(page.getByTestId("overview-meaningful-note")).toHaveText(
    "Meaningful leaves out tests, docs, and generated files.",
  );
  const roleRows = page.getByRole("region", { name: "By role" }).locator("tbody tr");
  for (const row of await roleRows.all()) {
    expect(
      Number((await row.locator("td").first().textContent())!.replace(/,/g, "")),
    ).toBeGreaterThan(0);
  }
  const kinds = page.getByRole("region", { name: "Change kinds" }).locator("dd");
  for (const value of await kinds.all()) {
    expect(Number((await value.textContent())!.replace(/,/g, ""))).toBeGreaterThan(0);
  }
});

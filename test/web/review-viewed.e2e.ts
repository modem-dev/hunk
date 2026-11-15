/**
 * Drives the viewed-files workflow against a rich live review.
 *
 * A file is marked viewed from its header checkbox, its flat sidebar row, or `V`; the mark is
 * shared through the session, so the toolbar's progress, the Overview, and a second page agree.
 * A viewed file's body collapses to one row that expands on click, "Hide viewed" removes viewed
 * files from this page only and navigation walks past them, and a file whose content changes
 * after it was marked says so. Hiding the selected file hands the selection to the nearest shown
 * one; an explicit jump (go to file, an agent's navigation) to a hidden file reveals it; hunk
 * navigation into a collapsed file opens it; and a mark cleared in another browser is forgotten.
 * Every step passes without a CSP violation or console error.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
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

/** Open the rich review and wait until every file has loaded. */
async function openTestReview(page: Page) {
  review = await startTestWebReview("--rich");
  problems = await watchTestPageProblems(page);
  await loadTestPage(page);
}

/** Load the running review in one page and wait until every file has loaded. */
async function loadTestPage(page: Page) {
  await page.goto(review!.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** Open the running review in a separate browser profile, with its own `localStorage`. */
async function openTestOtherBrowser(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await loadTestPage(page);
  return { page, close: () => context.close() };
}

/** The path of the file holding the selection. */
function selectedPath(page: Page) {
  return page.locator("section[data-selected]").getAttribute("aria-label");
}

/** Turn "Hide viewed" on or off from the toolbar. */
async function setTestHideViewed(page: Page, on: boolean) {
  const button = page.getByRole("button", { name: "Hide viewed" });
  if ((await button.getAttribute("aria-pressed")) !== String(on)) await button.click();
  await expect(button).toHaveAttribute("aria-pressed", String(on));
}

/** The stream section of one file. */
function section(page: Page, path: string) {
  return page.locator(`section.file-section[aria-label="${path}"]`);
}

/** The header checkbox of one file. */
function headerCheckbox(page: Page, path: string) {
  return section(page, path).locator(".viewed-toggle input");
}

/** How many viewed marks the session reports through the shared state. */
async function sharedViewedCount() {
  const state = (await review!.readApi("state")).state as { viewedFiles: Record<string, unknown> };
  return Object.keys(state.viewedFiles).length;
}

test("marks a file viewed from its header, collapses it, and counts it everywhere", async ({
  page,
}) => {
  await openTestReview(page);
  const progress = page.getByTestId("viewed-progress");
  const total = Number((await page.getByTestId("file-count").textContent())!.match(/\d+/)![0]);
  await expect(progress).toHaveText(`0 of ${total} viewed`);

  const main = section(page, "src/app/main.ts");
  await headerCheckbox(page, "src/app/main.ts").click();
  await expect(progress).toHaveText(`1 of ${total} viewed`);
  await expect.poll(sharedViewedCount).toBe(1);
  await expect(page.getByTestId("overview-viewed")).toContainText("1 of");

  // Collapsed to one row; a click expands it and the header can collapse it again.
  await expect(main.locator(".file-collapsed")).toBeVisible();
  await expect(main.locator(".file-body")).toHaveCount(0);
  await main.locator(".file-collapsed").click();
  await expect(main.locator(".file-body")).toBeVisible();
  await main.getByRole("button", { name: "Collapse" }).click();
  await expect(main.locator(".file-collapsed")).toBeVisible();

  // Navigating into a collapsed viewed file by hunk opens it where the reveal lands.
  await page.locator(".review-stream").focus();
  await page.keyboard.press("]");
  await page.keyboard.press("[");
  await expect(page.locator("section[data-selected]")).toHaveAttribute(
    "aria-label",
    "src/app/main.ts",
  );
  await expect(main.locator(".file-body")).toBeVisible();
  await main.getByRole("button", { name: "Collapse" }).click();

  // Clearing the mark from the keyboard-free mouse path in the flat sidebar.
  await page.getByRole("radio", { name: "Flat" }).click();
  const row = page.locator(".flat-row", { hasText: "main.ts" }).first();
  await expect(row.locator(".flat-viewed")).toBeChecked();
  await row.locator(".flat-viewed").click();
  await expect(progress).toHaveText(`0 of ${total} viewed`);
  await expect(main.locator(".file-body")).toBeVisible();
  await expect(headerCheckbox(page, "src/app/main.ts")).not.toBeChecked();
});

test("toggles the selected file with V and shares the mark with a second page", async ({
  page,
  context,
}) => {
  await openTestReview(page);
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("V");
  await expect(headerCheckbox(page, "src/app/main.ts")).toBeChecked();

  const second = await context.newPage();
  await second.goto(review!.url);
  await expect(second.locator('.toolbar [data-state="connected"]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(headerCheckbox(second, "src/app/main.ts")).toBeChecked();
  await expect(section(second, "src/app/main.ts").locator(".file-collapsed")).toBeVisible();

  await page.keyboard.press("V");
  await expect(headerCheckbox(page, "src/app/main.ts")).not.toBeChecked();
  await expect(headerCheckbox(second, "src/app/main.ts")).not.toBeChecked();
  await second.close();
});

test("hides viewed files on this page only, and navigation walks past them", async ({ page }) => {
  await openTestReview(page);
  await headerCheckbox(page, "src/app/renamed-new.ts").click();
  await expect(page.getByTestId("viewed-progress")).toHaveText(/^1 of/);

  await page.getByRole("button", { name: "Hide viewed" }).click();
  await expect(page.getByRole("button", { name: "Hide viewed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(section(page, "src/app/renamed-new.ts")).toHaveCount(0);
  await page.getByRole("radio", { name: "Flat" }).click();
  await expect(page.locator(".flat-row", { hasText: "renamed-new.ts" })).toHaveCount(0);

  // `}` (next file) from the first file skips the hidden second one.
  await page.locator(".flat-file", { hasText: "main.ts" }).first().click();
  await expect(page.locator("section[data-selected]")).toHaveAttribute(
    "aria-label",
    "src/app/main.ts",
  );
  await page.locator(".review-stream").focus();
  await page.keyboard.press("}");
  await expect(page.locator("section[data-selected]")).not.toHaveAttribute(
    "aria-label",
    /renamed-new/,
  );

  // The choice is this browser's: it survives a reload, and the palette turns it off.
  await page.reload();
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
  await expect(section(page, "src/app/renamed-new.ts")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Hide or show viewed");
  await page.keyboard.press("Enter");
  await expect(section(page, "src/app/renamed-new.ts")).toHaveCount(1);
  // The mark itself was never touched.
  expect(await sharedViewedCount()).toBe(1);
});

test("says when a viewed file changed after it was marked", async ({ page }) => {
  await openTestReview(page);
  await headerCheckbox(page, "src/app/main.ts").click();
  await expect(page.getByTestId("viewed-progress")).toHaveText(/^1 of/);

  const generation = await page.locator(".review-app").getAttribute("data-generation");
  await review!.reload();
  await expect(page.locator(".review-app")).not.toHaveAttribute(
    "data-generation",
    generation ?? "",
    { timeout: 30_000 },
  );

  const main = section(page, "src/app/main.ts");
  await expect(main.locator(".viewed-changed")).toHaveText("Changed since viewed");
  await expect(headerCheckbox(page, "src/app/main.ts")).not.toBeChecked();
  await expect(main.locator(".file-body")).toBeVisible();
  await expect(page.getByTestId("viewed-progress")).toHaveText(/^0 of/);

  // Marking it again clears the notice.
  await headerCheckbox(page, "src/app/main.ts").click();
  await expect(main.locator(".viewed-changed")).toHaveCount(0);
});

// Intent: marking the selected file viewed with "Hide viewed" on must not strand the reader on
// a file nothing shows: the selection moves to the next shown file and navigation goes on from
// there; when nothing is left the stream says so and offers the way back.
test("hands the selection on when the selected file is hidden", async ({ page }) => {
  await openTestReview(page);
  await setTestHideViewed(page, true);
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await expect.poll(() => selectedPath(page)).toBe("src/app/main.ts");

  await page.keyboard.press("V");
  await expect(section(page, "src/app/main.ts")).toHaveCount(0);
  await expect.poll(() => selectedPath(page)).toBe("src/app/renamed-new.ts");
  await page.keyboard.press(".");
  await expect.poll(() => selectedPath(page)).toBe("docs/日本語 ノート.md");
  await page.keyboard.press(",");
  await expect.poll(() => selectedPath(page)).toBe("src/app/renamed-new.ts");

  // Only the selected file left by the filter, then viewed: the stream says everything is hidden.
  await page.getByTestId("filter-input").fill("renamed-new");
  await expect(page.locator("section[data-file-key]")).toHaveCount(1);
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("V");
  const empty = page.locator(".stream-empty");
  await expect(empty).toContainText("Every file here is viewed and hidden.");
  await empty.getByRole("button", { name: "Show viewed files" }).click();
  await expect(section(page, "src/app/renamed-new.ts")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Hide viewed" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

// Intent: an explicit jump to a file "Hide viewed" removes — the reader's go to file, an agent's
// navigation — shows that file, expanded, until the next jump lands elsewhere or the setting is
// toggled; it is never silently dropped.
test("reveals a hidden viewed file an explicit jump names", async ({ page }) => {
  await openTestReview(page);
  await headerCheckbox(page, "src/app/renamed-new.ts").click();
  await expect(page.getByTestId("viewed-progress")).toHaveText(/^1 of/);
  await setTestHideViewed(page, true);
  const renamed = section(page, "src/app/renamed-new.ts");
  await expect(renamed).toHaveCount(0);

  await page.keyboard.press("Control+p");
  await page.keyboard.type("renamed-new");
  await expect(page.getByTestId("go-to-file").getByRole("option").first()).toContainText(
    "renamed-new.ts",
  );
  await page.keyboard.press("Enter");
  await expect(renamed.locator(".file-body")).toBeVisible();
  await expect.poll(() => selectedPath(page)).toBe("src/app/renamed-new.ts");
  await expect(page.locator(".toast")).toHaveCount(0);

  // The next jump elsewhere hides it again.
  await page.locator(".review-stream").focus();
  await page.keyboard.press(".");
  await expect.poll(() => selectedPath(page)).toBe("docs/日本語 ノート.md");
  await expect(renamed).toHaveCount(0);

  await review!.hunk([
    "session",
    "navigate",
    review!.sessionId,
    "--file",
    "src/app/renamed-new.ts",
    "--hunk",
    "1",
  ]);
  await expect(renamed.locator(".file-body")).toBeVisible();
  await expect.poll(() => selectedPath(page)).toBe("src/app/renamed-new.ts");
  await expect(page.getByTestId("selected-hunk")).toBeInViewport();

  // Toggling the setting ends the reveal: on again, the file is hidden again.
  await setTestHideViewed(page, false);
  await setTestHideViewed(page, true);
  await expect(renamed).toHaveCount(0);
});

// Intent: `]` from a file's last hunk enters the next file at its top; when that file is
// collapsed as viewed, it opens, so the selected hunk is drawn rather than a one-row stub.
test("opens a collapsed viewed file that hunk navigation enters", async ({ page }) => {
  await openTestReview(page);
  await headerCheckbox(page, "src/app/renamed-new.ts").click();
  const renamed = section(page, "src/app/renamed-new.ts");
  await expect(renamed.locator(".file-collapsed")).toBeVisible();

  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await expect.poll(() => selectedPath(page)).toBe("src/app/main.ts");
  await page.keyboard.press("]");
  await page.keyboard.press("]");
  await expect.poll(() => selectedPath(page)).toBe("src/app/renamed-new.ts");
  await expect(renamed.locator(".file-body")).toBeVisible();
  await expect(renamed.locator(".file-collapsed")).toHaveCount(0);

  // File navigation lands on the collapsed row and leaves it collapsed.
  await renamed.getByRole("button", { name: "Collapse" }).click();
  await page.locator(".review-stream").focus();
  await page.keyboard.press(",");
  await page.keyboard.press(".");
  await expect.poll(() => selectedPath(page)).toBe("src/app/renamed-new.ts");
  await expect(renamed.locator(".file-collapsed")).toBeVisible();
});

// Intent: a mark cleared in another browser leaves the shared state while the content still
// matches; this browser forgets it, so a later content change is not "Changed since viewed".
test("forgets a mark another browser cleared", async ({ page, browser }) => {
  await openTestReview(page);
  await headerCheckbox(page, "src/app/main.ts").click();
  await expect(page.getByTestId("viewed-progress")).toHaveText(/^1 of/);

  const other = await openTestOtherBrowser(browser);
  try {
    await expect(headerCheckbox(other.page, "src/app/main.ts")).toBeChecked();
    await headerCheckbox(other.page, "src/app/main.ts").click();
    await expect(headerCheckbox(page, "src/app/main.ts")).not.toBeChecked();
  } finally {
    await other.close();
  }

  const generation = await page.locator(".review-app").getAttribute("data-generation");
  await review!.reload();
  await expect(page.locator(".review-app")).not.toHaveAttribute(
    "data-generation",
    generation ?? "",
    { timeout: 30_000 },
  );
  const main = section(page, "src/app/main.ts");
  await expect(main.locator(".file-body")).toBeVisible();
  await expect(main.locator(".viewed-changed")).toHaveCount(0);
});

test("has no serious accessibility violations with viewed files", async ({ page }) => {
  await openTestReview(page);
  await headerCheckbox(page, "src/app/main.ts").click();
  await page.getByRole("radio", { name: "Flat" }).click();
  await expect(section(page, "src/app/main.ts").locator(".file-collapsed")).toBeVisible();
  const results = await new AxeBuilder({ page })
    .exclude("diffs-container")
    .exclude("file-tree-container")
    .analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
});

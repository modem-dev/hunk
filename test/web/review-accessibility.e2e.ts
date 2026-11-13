/**
 * Runs axe over the review page in the states other specs leave unchecked: the help overlay,
 * go-to-file, an open note composer and a saved note card, the side panel's Overview and Notes
 * tabs with notes present, a selected sidebar row with a note badge across themes, a collapsed
 * viewed file and hidden viewed files, the ended session, and image previews in swipe and
 * onion-skin modes beside rendered Markdown.
 *
 * Page-wide checks exclude Pierre's `diffs-container` and the tree's container, as the other
 * specs do, because their shadow DOM is third-party. Composers and note cards are the page's own
 * DOM slotted into `diffs-container`, so a page-wide check never reaches them; they get a scoped
 * check of their own. Only serious and critical violations fail.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  chooseTestTheme,
  startTestWebReview,
  watchTestPageProblems,
  type TestWebReview,
} from "./webTestHarness";

let review: TestWebReview | undefined;
let problems: string[] = [];

test.use({ viewport: { width: 1440, height: 900 } });

test.afterEach(async () => {
  // Check the page before stopping (a stopped daemon cuts its event stream), but always stop.
  try {
    expect(problems).toEqual([]);
  } finally {
    await review?.stop();
    review = undefined;
  }
});

/** Start one scenario and open the page once it has loaded every file. */
async function openTestReview(page: Page, input: "--rich" | "--previews") {
  review = await startTestWebReview(input, input === "--rich" ? { args: ["--agent-notes"] } : {});
  problems = await watchTestPageProblems(page);
  await page.addInitScript(() =>
    window.localStorage.setItem("hunk.review.view", '{"layout":"unified","sidebarMode":"flat"}'),
  );
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** Serious and critical violations on the page, outside third-party shadow DOM. */
async function seriousPageViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .exclude("diffs-container")
    .exclude("file-tree-container")
    .analyze();
  return describeTestViolations(results.violations);
}

/** Serious and critical violations inside the page's own elements matching `selector`. */
async function seriousViolationsWithin(page: Page, selector: string) {
  const results = await new AxeBuilder({ page }).include(selector).analyze();
  // A selector that matched nothing axe can reach would pass vacuously.
  expect(results.passes.length).toBeGreaterThan(0);
  return describeTestViolations(results.violations);
}

/** One readable line per serious or critical violation, naming the offending nodes. */
function describeTestViolations(
  violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"],
) {
  return violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`,
    );
}

test("passes axe with the help overlay and go-to-file open", async ({ page }) => {
  await openTestReview(page, "--rich");
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });

  await page.keyboard.press("?");
  await expect(page.getByTestId("help-overlay")).toBeVisible();
  expect(await seriousPageViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help-overlay")).toHaveCount(0);

  await page.keyboard.press("Control+p");
  const picker = page.getByTestId("go-to-file");
  await expect(picker.getByRole("option").first()).toBeVisible();
  expect(await seriousPageViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
});

test("passes axe inside an open composer and a saved note card", async ({ page }) => {
  await openTestReview(page, "--rich");
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });

  await page.keyboard.press("c");
  const composer = page.locator(".note-composer");
  await expect(composer).toBeVisible();
  expect(await seriousViolationsWithin(page, ".note-composer")).toEqual([]);

  await composer.locator("textarea").fill("Checked by axe.");
  await composer.locator("textarea").press("Control+Enter");
  await expect(composer).toHaveCount(0);
  const card = page.locator(".note-card", { hasText: "Checked by axe." });
  await expect(card).toBeVisible();
  expect(await seriousViolationsWithin(page, ".note-card")).toEqual([]);
});

/** Add one note on the first hunk with the keyboard and wait for its card. */
async function addTestNote(page: Page, body: string) {
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("c");
  await page.locator(".note-composer textarea").fill(body);
  await page.locator(".note-composer textarea").press("Control+Enter");
  await expect(page.locator(".note-card", { hasText: body })).toBeVisible();
}

test("passes axe on the side panel's Overview and Notes tabs with notes present", async ({
  page,
}) => {
  await openTestReview(page, "--rich");
  await addTestNote(page, "A note for the panel.");
  const panel = '[data-testid="side-panel"]';

  await page.keyboard.press("O");
  await expect(page.getByTestId("side-panel")).toBeVisible();
  expect(await seriousViolationsWithin(page, panel)).toEqual([]);

  await page.keyboard.press("N");
  await expect(page.getByTestId("side-panel")).toContainText("A note for the panel.");
  expect(await seriousViolationsWithin(page, panel)).toEqual([]);
});

// The note badge on a flat row is drawn in the theme's text color. Checked on the selected row,
// the hardest background it sits on, in the default theme, the built-in theme with the weakest
// accent (light-plus), and the one with the weakest text on that background (everforest-light).
test("passes axe on a selected sidebar row with a note badge in several themes", async ({
  page,
}) => {
  await openTestReview(page, "--rich");
  await addTestNote(page, "A note for the badge.");
  const badge = page.locator('.flat-file[data-selected] [data-badge="agent-comment"]');
  await expect(badge).toBeVisible();

  for (const themeId of ["github-dark-default", "light-plus", "everforest-light"]) {
    await chooseTestTheme(page, themeId);
    expect({
      themeId,
      violations: await seriousViolationsWithin(page, ".flat-file[data-selected]"),
    }).toEqual({ themeId, violations: [] });
  }
});

test("passes axe with a viewed file collapsed and with viewed files hidden", async ({ page }) => {
  await openTestReview(page, "--rich");
  const firstSection = page.locator("section[data-file-key]").first();
  // The mark shows once the session echoes it back, so click rather than `check()`.
  await firstSection.locator(".viewed-toggle input").click();
  await expect(firstSection.locator(".viewed-toggle input")).toBeChecked();
  await expect(firstSection.locator(".file-collapsed")).toBeVisible();
  expect(await seriousPageViolations(page)).toEqual([]);

  const hide = page.getByRole("button", { name: "Hide viewed" });
  await hide.click();
  await expect(hide).toHaveAttribute("aria-pressed", "true");
  expect(await seriousPageViolations(page)).toEqual([]);
});

test("passes axe once the session has ended", async ({ page }) => {
  await openTestReview(page, "--rich");
  await addTestNote(page, "A note before the end.");
  await review!.endSession();
  await expect(page.getByTestId("session-ended")).toBeVisible({ timeout: 15_000 });

  expect(await seriousPageViolations(page)).toEqual([]);
  expect(await seriousViolationsWithin(page, ".note-card")).toEqual([]);
});

test("passes axe with rendered Markdown and each image comparison mode", async ({ page }) => {
  await openTestReview(page, "--previews");
  const guide = page.locator('section[aria-label="docs/guide.md"]');
  await guide.getByTestId("markdown-mode-rendered").click();
  const photo = page.locator('section[aria-label="images/photo.png"]');
  const preview = photo.getByTestId("image-preview");
  await expect(preview).toBeVisible();

  for (const mode of ["swipe", "onion"] as const) {
    await preview.getByTestId(`image-mode-${mode}`).click();
    await expect(preview.getByTestId("image-slider")).toBeVisible();
    expect({ mode, violations: await seriousPageViolations(page) }).toEqual({
      mode,
      violations: [],
    });
  }
});

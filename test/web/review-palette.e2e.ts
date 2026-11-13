/**
 * Drives the page's finding tools against a real headless session: the command palette, the
 * help overlay, go-to-file, and deep links with back and forward.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { startTestWebReview, watchTestPageProblems, type TestWebReview } from "./webTestHarness";

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

/** Start the rich review and open the page, optionally at a fragment address. */
async function openTestReview(page: Page, at?: (fileKeys: string[]) => string) {
  review = await startTestWebReview("--rich");
  problems = await watchTestPageProblems(page);
  await page.addInitScript(() =>
    window.localStorage.setItem("hunk.review.view", '{"layout":"unified","sidebarMode":"flat"}'),
  );
  let url = review.url;
  if (at) {
    const keys = await fileKeys();
    url = `${url}&at=${encodeURIComponent(at(keys))}`;
  }
  await page.goto(url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** The session's file keys in review order. */
async function fileKeys() {
  const state = (await review!.readApi("state")).state as { files: { key: string }[] };
  return state.files.map((file) => file.key);
}

/** The address text the page shows in its fragment. */
function fragmentAddress(page: Page) {
  return new URLSearchParams(new URL(page.url()).hash.slice(1)).get("at");
}

/** The selected hunk's file and index, from the accent rail. */
async function selectedHunk(page: Page) {
  const rail = page.getByTestId("selected-hunk");
  await expect(rail).toHaveCount(1);
  const section = page.locator("section[data-file-key]", { has: rail });
  return {
    fileKey: await section.getAttribute("data-file-key"),
    hunkIndex: await rail.getAttribute("data-hunk-index"),
  };
}

test("runs commands from the palette, recent first, with focus restored", async ({ page }) => {
  await openTestReview(page);
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });

  await page.keyboard.press("Control+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette.getByRole("combobox")).toBeFocused();
  await expect(palette.getByRole("option", { name: /Quit/ })).toHaveCount(0);
  await page.keyboard.type("split");
  await expect(palette.getByRole("option").first()).toContainText("Split");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.locator(".review-app")).toHaveAttribute("data-layout", "split");

  await page.keyboard.press("Control+k");
  await expect(palette.getByRole("option").first()).toContainText("Split");
  const results = await new AxeBuilder({ page })
    .exclude("diffs-container")
    .exclude("file-tree-container")
    .analyze();
  expect(
    results.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // Closing gives focus back to what had it.
  await page.getByTestId("refresh").focus();
  await page.keyboard.press("Control+k");
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("refresh")).toBeFocused();
});

test("shows help for the commands that work here", async ({ page }) => {
  await openTestReview(page);
  await page.keyboard.press("?");
  const help = page.getByTestId("help-overlay");
  await expect(help.getByRole("heading", { name: "Navigation" })).toBeVisible();
  await expect(help.getByRole("row", { name: /previous \/ next hunk/ })).toContainText("[ / ]");
  await expect(help.getByRole("row", { name: /command palette/ })).toBeVisible();
  await expect(help).not.toContainText("quit");
  await expect(help).not.toContainText("open menus");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("goes to a file with change letters and stats, respecting the filter", async ({ page }) => {
  await openTestReview(page);
  await page.keyboard.press("Control+p");
  const picker = page.getByTestId("go-to-file");
  await page.keyboard.type("mod05");
  const option = picker.getByRole("option").first();
  await expect(option).toContainText("src/gen/module-05.ts");
  await expect(option.locator(".file-glyph")).toHaveText("M");
  await expect(option).toContainText("+1");
  await page.keyboard.press("Enter");
  const keys = await fileKeys();
  const moduleKey = keys[7 + 5]!;
  await expect
    .poll(() => fragmentAddress(page))
    .toBe(`file/${encodeURIComponent(moduleKey)}/hunk/0`);
  expect((await selectedHunk(page)).fileKey).toBe(moduleKey);

  // Back returns to where the reader was before the jump.
  await page.goBack();
  await expect.poll(async () => (await selectedHunk(page)).fileKey).toBe(keys[0]);
  await page.goForward();
  await expect.poll(async () => (await selectedHunk(page)).fileKey).toBe(moduleKey);

  await page.getByTestId("filter-input").fill("module-1");
  await expect(page.getByTestId("shared-filter")).toBeVisible();
  await page.keyboard.press("Control+p");
  await page.keyboard.type("main.ts");
  await expect(picker.getByRole("option")).toHaveCount(0);
  await expect(picker).toContainText("No matching files.");
  await page.keyboard.press("Escape");
  await page.getByTestId("filter-input").fill("");
});

test("opens at a deep link, follows navigation, and copies a link to the hunk", async ({
  page,
}) => {
  await openTestReview(page, (keys) => `file/${encodeURIComponent(keys[0]!)}/hunk/1`);
  const keys = await fileKeys();
  await expect.poll(async () => (await selectedHunk(page)).hunkIndex).toBe("1");
  expect(page.url()).not.toContain("capability");

  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("]");
  await expect
    .poll(() => fragmentAddress(page))
    .toBe(`file/${encodeURIComponent(keys[1]!)}/hunk/0`);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.keyboard.press("Control+k");
  await page.keyboard.type("copy link to this");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("toasts")).toContainText(
    "Link copied. It includes this review's access key",
  );
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  const params = new URLSearchParams(copied.hash.slice(1));
  expect(params.get("capability")).toBe(
    new URLSearchParams(new URL(review!.url).hash.slice(1)).get("capability"),
  );
  expect(params.get("at")).toBe(`file/${encodeURIComponent(keys[1]!)}/hunk/0`);

  // A link to a place the review does not have says so and moves nothing.
  const other = await page.context().newPage();
  const otherProblems = await watchTestPageProblems(other);
  await other.goto(`${review!.url}&at=${encodeURIComponent("file/missing/hunk/0")}`);
  await expect(other.getByTestId("toasts")).toContainText("does not have");
  expect(otherProblems).toEqual([]);
});

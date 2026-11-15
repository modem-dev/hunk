/**
 * Drives the page shell's keyboard, viewed-file, sidebar, and address behavior against a real
 * live review.
 *
 * Keyboard: Space on a focused "Viewed" checkbox toggles it instead of paging the stream;
 * `]` typed through AltGr (Ctrl+Alt) or Option (Alt) navigates; a focused side panel scrolls
 * itself while letter shortcuts still work from it. Writing: a composer opens where the diff is
 * drawn, so a collapsed viewed file expands and a rendered Markdown file returns to its diff.
 * Viewed files: a mark sent as the review reloads is not applied to content the reader never
 * saw, a double press inverts instead of repeating, and a held key sends once. Sidebar and
 * address: clicking the selected file in the tree jumps to it, a directory row leaves the file
 * highlighted, repeated jumps add one history entry, a pasted link's access key leaves the
 * address, and closing a dialog with its own chord restores focus. A refused filter edit
 * resets the field.
 */
import { expect, test, type Page } from "@playwright/test";
import { parseReviewCapabilityFragment } from "../../packages/hunk/src/session/reviewHttpProtocol";
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
  // Check the page before stopping (a stopped daemon cuts its event stream), but always stop.
  try {
    expect(problems).toEqual([]);
  } finally {
    await review?.stop();
    review = undefined;
  }
});

/** Open one scenario in the given sidebar mode and wait until every file has loaded. */
async function openTestReview(
  page: Page,
  input: string,
  sidebarMode: "flat" | "tree" = "flat",
  options: TestWebReviewOptions = {},
) {
  review = await startTestWebReview(input, options);
  problems = await watchTestPageProblems(page);
  await page.addInitScript(
    (mode) =>
      window.localStorage.setItem(
        "hunk.review.view",
        `{"layout":"unified","sidebarMode":"${mode}"}`,
      ),
    sidebarMode,
  );
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator("section[data-selected]")).toBeVisible({ timeout: 15_000 });
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

/** The scroll offset of the review stream. */
function streamScroll(page: Page) {
  return page.locator(".review-stream").evaluate((stream) => stream.scrollTop);
}

/** Where the reader is: the selected file and hunk. */
async function selectedHunk(page: Page) {
  return `${await page.locator("section[data-selected]").getAttribute("aria-label")}#${await page
    .getByTestId("selected-hunk")
    .getAttribute("data-hunk-index")}`;
}

// Intent: Space is a checkbox's only native key; the page must not turn it into a page-down.
test("Space on a focused Viewed checkbox toggles it instead of paging", async ({ page }) => {
  await openTestReview(page, "--rich");
  const progress = page.getByTestId("viewed-progress");
  const checkbox = headerCheckbox(page, "src/app/main.ts");
  await checkbox.focus();
  const before = await streamScroll(page);

  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await expect(progress).toContainText("1 of");
  await expect.poll(sharedViewedCount).toBe(1);
  expect(await streamScroll(page)).toBe(before);

  // The flat sidebar row's box keeps Space too.
  await page.getByRole("checkbox", { name: "Viewed main.ts", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(progress).toContainText("0 of");
  expect(await streamScroll(page)).toBe(before);
});

// Intent: German and Nordic layouts type `]` with AltGr (Windows: Ctrl+Alt) or Option (macOS:
// Alt); hunk navigation must still fire, while real browser chords stay the browser's.
test("hunk keys typed through AltGr and Option navigate", async ({ page }) => {
  await openTestReview(page, "--rich");
  await page.locator(".review-stream").focus();
  const start = await selectedHunk(page);

  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("]");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await expect.poll(() => selectedHunk(page)).not.toBe(start);
  const afterAltGr = await selectedHunk(page);

  await page.keyboard.down("Alt");
  await page.keyboard.press("[");
  await page.keyboard.up("Alt");
  await expect.poll(() => selectedHunk(page)).not.toBe(afterAltGr);

  // A real chord is not a hunk key: Ctrl+] does nothing.
  const before = await selectedHunk(page);
  await page.keyboard.press("Control+]");
  await page.waitForTimeout(200);
  expect(await selectedHunk(page)).toBe(before);
});

// Intent: the side panel body is a focusable scroll region; the arrow and paging keys scroll
// it, and letter shortcuts still run from it.
test("a focused side panel scrolls from the keyboard and keeps letter shortcuts", async ({
  page,
}) => {
  await openTestReview(page, "--rich");
  await page.setViewportSize({ width: 1440, height: 380 });
  await page.keyboard.press("O");
  const panel = page.locator('[role="tabpanel"]');
  await expect(panel).toBeVisible();
  await expect
    .poll(() => panel.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await panel.focus();
  const streamBefore = await streamScroll(page);

  await page.keyboard.press("PageDown");
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await streamScroll(page)).toBe(streamBefore);

  const start = await selectedHunk(page);
  await page.keyboard.press("]");
  await expect.poll(() => selectedHunk(page)).not.toBe(start);
});

// Intent: a composer renders only in the diff, so opening one shows the diff first.
test("c expands a collapsed viewed file and opens its composer", async ({ page }) => {
  await openTestReview(page, "--rich");
  const main = section(page, "src/app/main.ts");
  await page
    .getByRole("button", { name: /main\.ts/ })
    .first()
    .click();
  await page.keyboard.press("Shift+V");
  await expect(main.locator(".file-collapsed")).toBeVisible();

  await page.locator(".review-stream").focus();
  await page.keyboard.press("c");
  await expect(page.locator(".note-composer")).toBeVisible();
  await expect(main.locator(".file-body")).toBeVisible();
  await expect(main.locator(".note-composer")).toBeVisible();
});

test("c returns a rendered Markdown file to its diff and opens its composer", async ({ page }) => {
  await openTestReview(page, "--previews");
  const guide = section(page, "docs/guide.md");
  await guide.scrollIntoViewIfNeeded();
  await guide.getByTestId("markdown-mode-rendered").click();
  await expect(guide.getByTestId("markdown-preview")).toBeVisible();
  await expect(guide).toHaveAttribute("data-selected", "");

  await page.keyboard.press("c");
  await expect(guide.locator(".note-composer")).toBeVisible();
  await expect(guide.getByTestId("markdown-preview")).toHaveCount(0);
});

// Intent: a mark belongs to the content the reader saw; a click that races a reload which
// changes the file is refused, not retried against the new content.
test("a viewed mark sent as the file changes is not applied to the new content", async ({
  page,
}) => {
  await openTestReview(page, "--rich");
  let refuseNext = true;
  await page.route("**/actions", async (route) => {
    const body = route.request().postDataJSON() as { action: { type: string; fileKey?: string } };
    if (!refuseNext || body.action.type !== "files/set-viewed") return route.continue();
    refuseNext = false;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "stale-generation", message: "stale" }),
    });
    // The reload edits `src/app/main.ts` and leaves every other file as it was.
    await review!.reload();
  });

  await headerCheckbox(page, "src/app/main.ts").click();
  await expect(page.getByTestId("toasts")).toContainText(
    "The review changed after this request was prepared.",
  );
  await expect(headerCheckbox(page, "src/app/main.ts")).not.toBeChecked();
  expect(await sharedViewedCount()).toBe(0);
  await expect(page.getByTestId("viewed-progress")).toContainText("0 of");
  await expect(section(page, "src/app/main.ts").locator(".viewed-toggle")).toHaveAttribute(
    "data-status",
    "unviewed",
  );

  // A file the reload left alone is sent again once the new generation shows.
  refuseNext = true;
  const other = page.locator("section.file-section").nth(1);
  const otherPath = (await other.getAttribute("aria-label"))!;
  expect(otherPath).not.toBe("src/app/main.ts");
  await headerCheckbox(page, otherPath).click();
  await expect.poll(sharedViewedCount).toBe(1);
});

// Intent: pressing V twice quickly flips the mark twice, and a held key sends one request.
test("double toggles invert the pending mark and a held V sends once", async ({ page }) => {
  await openTestReview(page, "--rich");
  const sent: boolean[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/actions")) return;
    const action = (request.postDataJSON() as { action: { type: string; viewed?: boolean } })
      .action;
    if (action.type === "files/set-viewed") sent.push(action.viewed!);
  });
  await page.locator(".review-stream").focus();

  await page.keyboard.press("Shift+V");
  await page.keyboard.press("Shift+V");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent).toEqual([true, false]);
  await expect.poll(sharedViewedCount).toBe(0);

  sent.length = 0;
  await page.keyboard.down("Shift");
  for (let repeat = 0; repeat < 5; repeat += 1) await page.keyboard.down("V");
  await page.keyboard.up("V");
  await page.keyboard.up("Shift");
  await expect.poll(sharedViewedCount).toBe(1);
  expect(sent).toEqual([true]);
});

// Intent: the tree jump is a click, not only a selection change, because scrolling already made
// the file under the viewport the selection.
test("clicking the selected file in the tree jumps to its top", async ({ page }) => {
  await openTestReview(page, "--rich", "tree");
  const row = page.locator('file-tree-container [data-item-path="src/app/main.ts"]');
  await row.first().click();
  const offset = () =>
    section(page, "src/app/main.ts").evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        document.querySelector(".review-stream")!.getBoundingClientRect().top,
    );
  await expect.poll(offset).toBeLessThan(40);
  const atTop = await offset();

  await page.locator(".review-stream").evaluate((stream) => (stream.scrollTop += 220));
  await expect.poll(offset).toBeLessThan(atTop - 100);
  await row.first().click();
  await expect.poll(offset).toBeLessThan(atTop + 40);
  expect(await offset()).toBeGreaterThan(atTop - 40);
});

test("a directory row leaves the selected file highlighted in the tree", async ({ page }) => {
  await openTestReview(page, "--rich", "tree");
  const main = page.locator('file-tree-container [data-item-path="src/app/main.ts"]');
  await main.click();
  await expect(main).toHaveAttribute("aria-selected", "true");

  // A directory that holds no selected file takes the click; the highlight stays on the file.
  const folder = page.locator(
    'file-tree-container [data-item-type="folder"][data-item-path="src/gen/"]',
  );
  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expect(main).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator('file-tree-container [data-item-type="folder"][aria-selected="true"]'),
  ).toHaveCount(0);
});

// Intent: a jump to where the reader already is adds no history entry.
test("repeated jumps to the same file add one history entry", async ({ page }) => {
  await openTestReview(page, "--rich");
  const length = () => page.evaluate(() => window.history.length);
  const start = await length();
  const row = page.locator(".flat-file").nth(1);

  await row.click();
  await expect.poll(length).toBe(start + 1);
  await row.click();
  await row.click();
  await page.waitForTimeout(300);
  expect(await length()).toBe(start + 1);
});

// Intent: a copied link pasted into a tab already on the session leaves the key in tab storage
// only, and history writes never put it back.
test("a pasted link's access key leaves the address", async ({ page }) => {
  await openTestReview(page, "--rich");
  const capability = parseReviewCapabilityFragment(new URL(review!.url).hash)!;
  await page.evaluate((key) => {
    window.location.hash = `#capability=${key}`;
  }, capability);
  await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain("capability");

  await page.locator(".review-stream").focus();
  await page.keyboard.press("]");
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.location.hash)).not.toContain("capability");
  await page.reload();
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
});

// Intent: whichever way a dialog closes, focus returns to what had it.
test("the chord that opened a dialog closes it and restores focus", async ({ page }) => {
  await openTestReview(page, "--rich");
  const button = page.getByRole("button", { name: "Hide viewed" });
  await button.focus();

  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(button).toBeFocused();

  await page.keyboard.press("Control+p");
  await expect(page.getByTestId("go-to-file")).toBeVisible();
  await page.keyboard.press("Control+p");
  await expect(page.getByTestId("go-to-file")).toHaveCount(0);
  await expect(button).toBeFocused();
});

// Intent: a refused filter edit must not leave text the session never accepted in the field.
test("a refused filter edit resets the field to the shared filter", async ({ page }) => {
  await openTestReview(page, "--rich");
  await page.route("**/actions", async (route) => {
    const body = route.request().postDataJSON() as { action: { type: string } };
    if (body.action.type !== "filter/set") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  const filter = page.getByTestId("filter-input");
  await filter.fill("zzz-never-accepted");
  await expect(filter).toHaveValue("");
});

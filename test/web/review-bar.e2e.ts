/**
 * Drives the review bar along the bottom of the page against a rich live review.
 *
 * The bar shows viewed progress (moved from the toolbar), a "Next unviewed" button that walks to
 * the next file not marked viewed through the sidebar's path, key hints read from the keymap
 * and hidden from assistive technology, a note count that opens the Notes tab, and "Copy notes
 * for agent", which copies the visible notes as Markdown. Copying and navigation keep working
 * after the session ends. Every step passes without a CSP violation or console error.
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
  try {
    expect(problems).toEqual([]);
  } finally {
    await review?.stop();
    review = undefined;
  }
});

/** Open the rich review and wait until every file has loaded. */
async function openTestReview(page: Page, options: TestWebReviewOptions = {}) {
  review = await startTestWebReview("--rich", options);
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** The path of the file holding the selection. */
function selectedPath(page: Page) {
  return page.locator("section[data-selected]").getAttribute("aria-label");
}

/** The stream section of one file. */
function section(page: Page, path: string) {
  return page.locator(`section.file-section[aria-label="${path}"]`);
}

/** Add one live comment through the agent's own command; resolves its id. */
async function addTestComment(args: string[]) {
  const output = await review!.hunk([
    "session",
    "comment",
    "add",
    review!.sessionId,
    ...args,
    "--json",
  ]);
  return (JSON.parse(output) as { result: { commentId: string } }).result.commentId;
}

/** Mark every file viewed through the review link, as another browser would. */
async function markEveryTestFileViewed() {
  const state = (await review!.readApi("state")).state as { files: { key: string }[] };
  for (const file of state.files) {
    const response = await review!.postAction({
      type: "files/set-viewed",
      fileKey: file.key,
      viewed: true,
    });
    expect(response.ok).toBe(true);
  }
}

test("moves viewed progress to the bar and walks to the next unviewed file", async ({ page }) => {
  await openTestReview(page);
  const bar = page.getByTestId("review-bar");
  const progress = bar.getByTestId("viewed-progress");
  const next = bar.getByTestId("next-unviewed");

  // Progress lives in the bar now, and only there.
  await expect(progress).toHaveText(/^0 of \d+ viewed$/);
  await expect(page.locator(".toolbar .viewed-progress")).toHaveCount(0);

  // The bar walks review order from the selection: main.ts, then renamed-new.ts, then the docs.
  await expect(page.locator("section[data-selected]")).toHaveAttribute(
    "aria-label",
    "src/app/main.ts",
  );
  await expect(next).toContainText("Next unviewed");
  await expect(next.locator(".bar-next-name")).toHaveText("renamed-new.ts");
  await expect(next.locator(".bar-next-dir")).toHaveText("src/app/");

  // A folded file opens when the bar jumps to it.
  await section(page, "src/app/renamed-new.ts")
    .getByRole("button", { name: "Collapse file" })
    .click();
  await expect(
    section(page, "src/app/renamed-new.ts").getByRole("button", { name: "Expand file" }),
  ).toBeVisible();
  await next.click();
  await expect.poll(() => selectedPath(page)).toBe("src/app/renamed-new.ts");
  await expect(
    section(page, "src/app/renamed-new.ts").getByRole("button", { name: "Collapse file" }),
  ).toBeVisible();
  await expect(next.locator(".bar-next-name")).toHaveText("日本語 ノート.md");

  // A viewed file is skipped; the progress counts it.
  await section(page, "docs/日本語 ノート.md").locator(".viewed-toggle input").click();
  await expect(progress).toHaveText(/^1 of/);
  await expect(next.locator(".bar-next-name")).not.toHaveText("日本語 ノート.md");

  // With every file viewed the slot says so and the button is gone.
  await markEveryTestFileViewed();
  await expect(bar.getByTestId("all-viewed")).toHaveText("All files viewed");
  await expect(next).toHaveCount(0);
  await expect(progress).toHaveText(/^(\d+) of \1 viewed$/);
});

test("counts notes, opens the Notes tab, and copies the notes as Markdown", async ({ page }) => {
  await openTestReview(page, {
    args: ["--agent-notes"],
    context: {
      "src/app/main.ts": {
        annotations: [{ newRange: [13, 13], summary: "Threshold raised.", author: "sonnet" }],
      },
    },
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const bar = page.getByTestId("review-bar");
  const notes = bar.getByTestId("bar-notes");
  const copy = bar.getByTestId("copy-notes");

  await expect(notes).toHaveText("1 note");
  const root = await addTestComment([
    "--file",
    "src/gen/module-30.ts",
    "--new-line",
    "1",
    "--summary",
    "Far down the stream",
    "--author",
    "opus",
  ]);
  await addTestComment(["--reply-to", root, "--summary", "A reply to it"]);
  await expect(notes).toHaveText("3 notes");

  // The count opens the side panel on its Notes tab.
  await notes.click();
  await expect(page.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");

  // Copy writes the notes by file in review order, replies indented under their note.
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(copy).toHaveText("Copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.indexOf("## `src/app/main.ts`")).toBeGreaterThan(-1);
  expect(copied.indexOf("## `src/gen/module-30.ts`")).toBeGreaterThan(
    copied.indexOf("## `src/app/main.ts`"),
  );
  expect(copied).toContain("- **sonnet** (agent) · line 13\n  Threshold raised.");
  expect(copied).toContain("- **opus** (agent) · line 1\n  Far down the stream");
  expect(copied).toContain("\n  - **");
  expect(copied).toContain("    A reply to it");

  // Hidden agent notes are left out of the count and the copy, and the title says so.
  await page.locator(".review-stream").focus();
  await page.keyboard.press("a");
  await expect(notes).toHaveCount(0);
  await expect(copy).toBeDisabled();
  await expect(copy).toHaveAttribute("title", /Agent notes are hidden/);

  await page.keyboard.press("a");
  await expect(notes).toHaveText("3 notes");

  // After the session ends, copying still reads the page's notes and the next file still opens.
  await review!.endSession();
  await expect(page.getByTestId("session-ended")).toBeVisible();
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(copy).toHaveText("Copied");
  await bar.getByTestId("next-unviewed").click();
  await expect.poll(() => selectedPath(page)).not.toBe("src/app/main.ts");
});

test("hides the note count and disables copy without notes", async ({ page }) => {
  await openTestReview(page);
  const bar = page.getByTestId("review-bar");
  await expect(bar.getByTestId("bar-notes")).toHaveCount(0);
  await expect(bar.getByTestId("copy-notes")).toBeDisabled();
  await expect(bar.getByTestId("copy-notes")).toHaveAttribute("title", /no notes/);
});

test("keeps key hints from assistive technology and opens help from Shortcuts", async ({
  page,
}) => {
  await openTestReview(page);
  const bar = page.getByTestId("review-bar");
  const hints = bar.getByTestId("bar-key-hints");
  await expect(hints).toHaveAttribute("aria-hidden", "true");
  await expect(hints.locator(".bar-key")).toHaveCount(5);
  await expect(hints.locator('[data-hint="hunk"] kbd')).toHaveCount(2);

  await bar.getByTestId("bar-shortcuts").click();
  await expect(page.getByTestId("help-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help-overlay")).toHaveCount(0);

  const results = await new AxeBuilder({ page }).include('[data-testid="review-bar"]').analyze();
  expect(results.violations).toEqual([]);
});

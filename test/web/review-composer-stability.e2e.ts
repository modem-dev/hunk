/**
 * Checks that an open note composer survives unrelated changes to the review.
 *
 * Covers a composer staying the same DOM node, keeping the reader's focus and its "Discard
 * this draft?" confirmation while an agent comment lands; a draft opened inside an expanded
 * context gap staying visible once the gap is collapsed, and again after a tab reload; and
 * Discard refusing to remove a draft whose save is in flight.
 */
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

/** Start the rich review in the unified layout and open the page on it. */
async function openTestReview(page: Page, options: TestWebReviewOptions = {}) {
  review = await startTestWebReview("--rich", {
    ...options,
    args: ["--agent-notes", ...(options.args ?? [])],
  });
  problems = await watchTestPageProblems(page);
  await page.addInitScript(() =>
    window.localStorage.setItem("hunk.review.view", '{"layout":"unified","sidebarMode":"flat"}'),
  );
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** Add one live agent comment. */
async function addTestComment(summary: string, line = 13) {
  await review!.hunk([
    "session",
    "comment",
    "add",
    review!.sessionId,
    "--file",
    "src/app/main.ts",
    "--new-line",
    String(line),
    "--summary",
    summary,
  ]);
}

/** The first file's section. */
function mainSection(page: Page) {
  return page.locator("section[data-file-key]").first();
}

test("keeps an open composer mounted, focused where the reader left it, and mid-confirmation", async ({
  page,
}) => {
  await openTestReview(page);
  await page.keyboard.press("c");
  const textarea = page.locator(".note-composer textarea");
  await textarea.fill("Half written.");
  await textarea.evaluate((element) => {
    (element as HTMLElement & { testMarker?: string }).testMarker = "original";
  });
  // Ask to discard, then leave the composer for a toolbar control.
  await textarea.press("Escape");
  await expect(page.getByText("Discard this draft?").first()).toBeVisible();
  const toolbarButton = page.locator(".toolbar button").first();
  await toolbarButton.focus();
  await expect(toolbarButton).toBeFocused();

  await addTestComment("Landed while composing.");
  await expect(page.locator(".note-card", { hasText: "Landed while composing." })).toBeVisible();

  await expect(page.getByText("Discard this draft?").first()).toBeVisible();
  await expect(toolbarButton).toBeFocused();
  expect(
    await page
      .locator(".note-composer textarea")
      .evaluate((element) => (element as HTMLElement & { testMarker?: string }).testMarker),
  ).toBe("original");
  await expect(page.locator(".note-composer textarea")).toHaveValue("Half written.");
});

test("keeps a composer opened in an expanded gap visible after the gap is collapsed", async ({
  page,
}) => {
  await openTestReview(page);
  const main = mainSection(page);
  await main.locator('.gap-separator[data-gap-id="before:0"]').first().click();
  await expect(main.locator('[data-column-number="3"]').first()).toBeVisible({ timeout: 15_000 });
  await main.locator('[data-line="3"]').last().hover();
  await main.locator("[data-utility-button]").click();
  await expect(page.locator(".note-composer .note-range")).toHaveText("R3");
  await page.locator(".note-composer textarea").fill("Context draft.");

  await main.getByRole("button", { name: "Hide expanded lines" }).click();

  await expect(page.locator(".note-composer")).toBeVisible();
  await expect(page.locator(".note-composer textarea")).toHaveValue("Context draft.");

  await page.reload();
  await expect(page.locator(".note-composer textarea")).toHaveValue("Context draft.", {
    timeout: 30_000,
  });
  await expect(page.locator(".note-composer")).toBeVisible();
});

test("keeps focus in a composer whose own line receives a note", async ({ page }) => {
  await openTestReview(page);
  await page.keyboard.press("c");
  const textarea = page.locator(".note-composer textarea");
  await textarea.fill("Typing on a busy line.");
  const range = (await page.locator(".note-composer .note-range").textContent()) ?? "";
  const line = Number(range.replace(/^\D+/, ""));
  expect(line).toBeGreaterThan(0);

  await addTestComment("Landed on the same line.", line);
  await expect(page.locator(".note-card", { hasText: "Landed on the same line." })).toBeVisible();

  await expect(page.locator(".note-composer textarea")).toBeFocused();
  await expect(page.locator(".note-composer textarea")).toHaveValue("Typing on a busy line.");
});

test("cannot discard a composer while its save is in flight", async ({ page }) => {
  await openTestReview(page);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/actions", async (route) => {
    await held;
    await route.continue();
  });
  await page.keyboard.press("c");
  const textarea = page.locator(".note-composer textarea");
  await textarea.fill("Sent while discarding.");
  await textarea.press("Control+Enter");
  const composer = page.locator(".note-composer");
  await expect(composer).toHaveAttribute("data-status", "sending");

  await expect(composer.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await composer.getByRole("button", { name: "Saving…" }).press("Escape");
  await expect(composer).toBeVisible();

  release!();
  await expect(composer).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".note-card", { hasText: "Sent while discarding." })).toBeVisible();
});

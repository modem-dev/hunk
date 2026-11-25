/**
 * Keeps a 2,000-file review responsive: it loads, mounts only what is near the viewport,
 * loads the file a jump targets ahead of the rest, and jumps from the sidebar to the last file
 * quickly.
 */
import { expect, test } from "@playwright/test";
import { startTestWebReview, watchTestPageProblems, type TestWebReview } from "./webTestHarness";

const FILE_COUNT = 2_000;

/**
 * How long a jumped-to file may take to draw while the rest of the review loads. Loading
 * every file before it took about 30 s on an idle machine; loading it first takes 1-3 s, so
 * this leaves room for a loaded CI runner and still fails if the target waits its turn.
 */
const JUMP_DRAW_TIMEOUT_MS = 15_000;

let review: TestWebReview | undefined;

test.afterEach(async () => {
  await review?.stop();
  review = undefined;
});

test("stays responsive with 2,000 files", async ({ page }) => {
  test.setTimeout(180_000);
  review = await startTestWebReview(`--many=${FILE_COUNT}`);
  const problems = await watchTestPageProblems(page);
  await page.addInitScript(() =>
    window.localStorage.setItem("hunk.review.view", '{"sidebarMode":"flat"}'),
  );
  const drawnRows = (path: string) => page.locator(`section[aria-label="${path}"] [data-line]`);

  await page.goto(review.url);
  await expect(page.getByTestId("file-count")).toHaveText(
    `${FILE_COUNT.toLocaleString("en-US")} files`,
    {
      timeout: 30_000,
    },
  );

  // Go to file, while the review is still loading, lands on its file as soon as that file
  // loads rather than doing nothing.
  const middle = "pkg0/dir0/file-1000.ts";
  await page.getByTestId("review-stream").focus();
  await page.keyboard.press("Control+p");
  await page.keyboard.type("file-1000.ts");
  await expect(page.getByTestId("go-to-file").getByRole("option").first()).toContainText(middle);
  await page.keyboard.press("Enter");
  await expect(page.locator("section[data-selected] .file-path")).toHaveText(middle, {
    timeout: JUMP_DRAW_TIMEOUT_MS,
  });
  await expect(drawnRows(middle).first()).toBeVisible({ timeout: JUMP_DRAW_TIMEOUT_MS });

  // An agent's reveal of a file that is still loading loads it next and waits for it rather
  // than being dropped, or waiting for the files before it.
  const last = "pkg19/dir9/file-1999.ts";
  await review.hunk(["session", "navigate", review.sessionId, "--file", last, "--hunk", "1"]);
  await expect(page.locator("section[data-selected] .file-path")).toHaveText(last, {
    timeout: JUMP_DRAW_TIMEOUT_MS,
  });
  await expect(drawnRows(last).first()).toBeVisible({ timeout: JUMP_DRAW_TIMEOUT_MS });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 90_000 });
  // Files landing above the revealed file while the rest loaded left it where it was shown.
  await expect(page.locator("section[data-selected] .file-path")).toHaveText(last);
  await expect(drawnRows(last).first()).toBeInViewport();

  // Only files near the viewport carry a Pierre diff.
  const mounted = await page.locator("section[data-file-key] diffs-container").count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(100);

  const started = Date.now();
  await page.locator(".flat-file", { hasText: "file-1999.ts" }).click();
  await expect(
    page.locator("section[data-file-key]").last().locator("diffs-container"),
  ).toHaveCount(1, { timeout: 10_000 });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(problems).toEqual([]);
});

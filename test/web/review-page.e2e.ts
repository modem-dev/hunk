/**
 * Opens a live review in Chromium the way a person would: a real daemon from source, a real
 * session registered with it, and the review URL with its capability fragment.
 *
 * Asserts the page connects, shows the file count, renders Pierre diffs with syntax colors,
 * and does all of it under the page's content security policy without a violation or a
 * console error.
 */
import { expect, test } from "@playwright/test";
import {
  PATCH_FIXTURE,
  startTestWebReview,
  waitForTestCondition,
  watchTestPageProblems,
  type TestWebReview,
} from "./webTestHarness";

let review: TestWebReview | undefined;

test.afterEach(async () => {
  await review?.stop();
  review = undefined;
});

test("opens a live review, renders a Pierre diff, and stays inside the page CSP", async ({
  page,
}) => {
  review = await startTestWebReview(PATCH_FIXTURE);
  const problems = await watchTestPageProblems(page);

  const documentResponse = await page.goto(review.url);
  expect(documentResponse?.status()).toBe(200);
  expect(documentResponse?.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(documentResponse?.headers()["cache-control"]).toBe("no-store");

  await expect(page.locator('.toolbar [data-state="connected"]')).toHaveText("Connected");
  await expect(page.getByTestId("file-count")).toHaveText("2 files");

  // Pierre renders inside a shadow root; wait until the diff lines carry several syntax
  // colors, which only happens once the lazily loaded grammar and theme have arrived.
  const rendered = await waitForTestCondition(
    "Pierre to render the highlighted diff",
    () =>
      page.evaluate(() => {
        const container = document.querySelector("section[data-file-key] diffs-container");
        const root = container?.shadowRoot;
        if (!root) return undefined;
        const tokenColors = new Set(
          Array.from(root.querySelectorAll("span[style]"), (span) => getComputedStyle(span).color),
        );
        const text = root.textContent ?? "";
        return tokenColors.size > 2 ? { text } : undefined;
      }),
    30_000,
  );
  expect(rendered.text).toContain("punctuation");
  await expect(page.locator("section[data-file-key] .file-path").first()).toHaveText(
    "src/greeting.ts",
  );

  await page.waitForTimeout(500);
  expect(problems).toEqual([]);
});

// Intent: when the session ends, the daemon says so on the event stream and the page looks
// ended, not just says so: a banner that stays, and every control that needs the session
// disabled, while reading, layout, and the palette keep working.
test("shows that the session ended when its process exits", async ({ page }) => {
  review = await startTestWebReview("--rich");
  const problems = await watchTestPageProblems(page);
  await page.addInitScript(() =>
    window.localStorage.setItem("hunk.review.view", '{"layout":"unified","sidebarMode":"flat"}'),
  );
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toHaveText("Connected");
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("c");
  await page.locator(".note-composer textarea").fill("Written before the end.");
  await page.locator(".note-composer textarea").press("Control+Enter");
  const card = page.locator(".note-card", { hasText: "Written before the end." });
  await expect(card).toBeVisible();

  await review.endSession();

  await expect(page.locator('.toolbar [data-state="failed"]')).toHaveText("Session ended", {
    timeout: 15_000,
  });
  const banner = page.getByTestId("session-ended");
  await expect(banner).toHaveText(
    "This review session has ended. Run hunk diff --web again, or hunk session open for a running session.",
  );
  await expect(banner.locator("code")).toHaveText(["hunk diff --web", "hunk session open"]);
  await expect(banner.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("refresh")).toBeDisabled();
  await expect(page.getByTestId("filter-input")).toBeDisabled();
  await expect(card.locator("button.note-action")).not.toHaveCount(0);
  for (const button of await card.locator("button.note-action").all()) {
    await expect(button).toBeDisabled();
  }
  for (const box of await page.locator(".viewed-toggle input, input.flat-viewed").all()) {
    await expect(box).toBeDisabled();
  }

  // A key that would write shows the ended message instead of opening a composer or posting.
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("c");
  await expect(page.locator(".note-composer")).toHaveCount(0);
  await expect(page.getByTestId("toasts")).toContainText("This review session has ended.");
  await page.keyboard.press("V");
  await page.keyboard.press("a");
  await expect(page.locator(".viewed-toggle input:checked, input.flat-viewed:checked")).toHaveCount(
    0,
  );

  // Reading keeps working: layout, the palette, and the banner stays after both.
  await page.getByTestId("layout-split").click();
  await expect(page.locator(".review-app")).toHaveAttribute("data-layout", "split");
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(banner).toBeVisible();
  expect(problems).toEqual([]);
});

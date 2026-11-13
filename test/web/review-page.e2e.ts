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

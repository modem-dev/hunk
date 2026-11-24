/**
 * Serves a GitHub pull request in the browser through `hunk gh pr <number> --web`.
 *
 * The session runs the real `hunk gh` extension with GitHub answered from fixtures: it accepts
 * `--web --no-open --no-watch` as its own options, fetches the diff, and delegates to the same
 * headless `hunk patch` review a local patch gets, carrying the pull request's metadata. The
 * refresh button rereads the fetched patch, so the review and its metadata survive it unchanged.
 */
import { expect, test } from "@playwright/test";
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

/** The live session's context as `hunk session context --json` reports it. */
async function readTestSessionContext() {
  const output = await review!.hunk(["session", "context", review!.sessionId, "--json"]);
  return (JSON.parse(output) as { context: Record<string, unknown> }).context;
}

test("serves `hunk gh pr --web` like a local patch review, across a refresh", async ({ page }) => {
  review = await startTestWebReview("--github");
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });

  const greeting = page.locator('section[aria-label="src/greeting.ts"]');
  const readme = page.locator('section[aria-label="README.md"]');
  await expect(greeting).toBeVisible();
  await expect(readme).toBeVisible();
  expect(await readTestSessionContext()).toMatchObject({
    inputKind: "patch",
    review: {
      kind: "change-request",
      provider: "GitHub",
      id: "#1350",
      title: "Serve GitHub reviews in the browser",
    },
  });

  const generation = await page.locator(".review-app").getAttribute("data-generation");
  const refresh = page.getByTestId("refresh");
  const [refreshed] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/refresh"),
      { timeout: 30_000 },
    ),
    refresh.click(),
  ]);
  expect(refreshed.ok()).toBe(true);
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(refresh).toBeEnabled();
  await expect(page.getByTestId("toasts")).toBeEmpty();
  // Refresh rereads the patch fetched at startup: a new generation of the same files.
  await expect(page.locator(".review-app")).not.toHaveAttribute(
    "data-generation",
    generation ?? "",
  );
  await expect(greeting).toBeVisible();
  await expect(readme).toBeVisible();
  expect(await readTestSessionContext()).toMatchObject({
    review: { id: "#1350", title: "Serve GitHub reviews in the browser" },
  });
});

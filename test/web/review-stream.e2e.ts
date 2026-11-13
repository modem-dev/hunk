/**
 * Drives the read-only review page against a rich live review: many files, a rename, new,
 * deleted, binary, and too-large files, expandable gaps, and a non-ASCII path.
 *
 * Covers what a reviewer does: jumping between sidebar and stream, switching layout and
 * theme, expanding a gap, watching the review load progressively and reload to a new
 * generation in place — all without a CSP violation or console error, and without a serious
 * accessibility finding.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  chooseTestTheme,
  startTestWebReview,
  waitForTestCondition,
  watchTestPageProblems,
  type TestWebReview,
} from "./webTestHarness";

let review: TestWebReview | undefined;
let problems: string[] = [];

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  review = await startTestWebReview("--rich");
  problems = await watchTestPageProblems(page);
  // Record whether load progress was ever shown, however briefly.
  await page.addInitScript(() => {
    const seen = () => {
      if (document.querySelector('[data-testid="load-progress"]')) {
        (window as unknown as { __sawProgress: boolean }).__sawProgress = true;
      } else {
        requestAnimationFrame(seen);
      }
    };
    requestAnimationFrame(seen);
  });
});

test.afterEach(async () => {
  // Check the page before stopping (a stopped daemon cuts its event stream), but always stop.
  try {
    expect(problems).toEqual([]);
  } finally {
    await review?.stop();
    review = undefined;
  }
});

/** Open the review and wait until every file has loaded. */
async function openTestReview(page: Page) {
  await page.goto(review!.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("file-count")).toHaveText("47 files");
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** The file key of the section at the top of the stream's viewport. */
function topSection(page: Page) {
  return page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    const sections = Array.from(document.querySelectorAll<HTMLElement>("section[data-file-key]"));
    const top = sections.find(
      (section) => section.offsetTop + section.offsetHeight > stream.scrollTop,
    );
    return top
      ? { key: top.dataset.fileKey!, offset: stream.scrollTop - top.offsetTop }
      : undefined;
  });
}

test("loads progressively and shows every file shape", async ({ page }) => {
  await openTestReview(page);

  expect(
    await page.evaluate(() => (window as unknown as { __sawProgress?: boolean }).__sawProgress),
  ).toBe(true);
  await expect(page.locator('[data-empty-reason="rename-only"]')).toHaveText(
    "No textual hunks. This change only renames the file.",
  );
  await expect(page.locator('[data-empty-reason="binary"]')).toHaveText("Binary file skipped");
  await expect(page.locator('[data-empty-reason="too-large"]')).toHaveText(
    "File too large to render automatically.",
  );
  await expect(page.locator(".file-path", { hasText: "docs/日本語 ノート.md" })).toBeVisible();
  await expect(
    page.locator(".file-path", { hasText: "src/app/renamed-old.ts -> renamed-new.ts" }),
  ).toBeVisible();
});

test("jumps from the sidebar to the stream and follows the stream back", async ({ page }) => {
  await openTestReview(page);
  await page.getByRole("radio", { name: "Flat" }).click();

  await page.locator(".flat-file", { hasText: "module-30.ts" }).click();
  await waitForTestCondition("the stream to reveal module-30", async () => {
    const top = await topSection(page);
    const path = await page
      .locator(`section[data-file-key="${top?.key}"] .file-path`)
      .textContent();
    return path === "src/gen/module-30.ts" ? true : undefined;
  });
  await expect(page.locator(".flat-file[data-selected]")).toContainText("module-30.ts");

  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".review-stream")!.scrollTop = 0;
  });
  await expect(page.locator(".flat-file[data-selected]")).toContainText("main.ts");
});

test("switches layout and theme, and the theme choice persists", async ({ page }) => {
  await openTestReview(page);

  await page.getByTestId("layout-unified").click();
  await expect(page.locator(".review-app")).toHaveAttribute("data-layout", "unified");
  await page.getByTestId("layout-split").click();
  await expect(page.locator(".review-app")).toHaveAttribute("data-layout", "split");

  await chooseTestTheme(page, "dracula");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--hunk-background").trim(),
      ),
    )
    .toBe("#282a36");
  await page.reload();
  await expect(page.getByTestId("theme-picker")).toHaveAttribute("data-theme-id", "dracula");
});

test("expands a collapsed gap in place from the source resource", async ({ page }) => {
  await openTestReview(page);
  const main = page.locator("section[data-file-key]").first();
  const firstGap = main.locator('.gap-separator[data-gap-id="before:0"]').first();
  await expect(firstGap).toHaveText("9 unchanged lines", { timeout: 15_000 });

  await firstGap.click();

  await expect(main.getByRole("button", { name: "Hide expanded lines" })).toBeVisible();
  await waitForTestCondition("the expanded lines to render", () =>
    main.evaluate((section) =>
      section.querySelector("diffs-container")?.shadowRoot?.textContent?.includes("line0 = 0")
        ? true
        : undefined,
    ),
  );
  await main.getByRole("button", { name: "Hide expanded lines" }).click();
  await expect(main.locator('.gap-separator[data-gap-id="before:0"]').first()).toHaveText(
    "9 unchanged lines",
  );
});

test("reloads to a new generation and keeps the reader's place by file", async ({ page }) => {
  await openTestReview(page);
  const generation = await page.locator(".review-app").getAttribute("data-generation");
  await page.locator(".file-path", { hasText: "src/gen/module-20.ts" }).scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    const section = Array.from(
      document.querySelectorAll<HTMLElement>("section[data-file-key]"),
    ).find((candidate) => candidate.textContent?.includes("src/gen/module-20.ts"))!;
    stream.scrollTop = section.offsetTop + 10;
  });
  // Let the scroll settle: the sidebar follows it and the stream reports its top file.
  await page.waitForTimeout(400);
  const before = await topSection(page);

  await review!.reload();
  await expect(page.locator(".review-app")).not.toHaveAttribute(
    "data-generation",
    generation ?? "",
    {
      timeout: 30_000,
    },
  );

  const after = await topSection(page);
  expect(after?.key).toBe(before?.key);
  expect(Math.abs((after?.offset ?? 0) - (before?.offset ?? 0))).toBeLessThan(40);
});

// Intent: the reader's own keyboard scroll ends the post-reload position restore, rather
// than being pulled back by its next frame.
test("lets a keyboard scroll right after a reload stand", async ({ page }) => {
  await openTestReview(page);
  const generation = await page.locator(".review-app").getAttribute("data-generation");
  const scrollTop = () =>
    page.evaluate(() => document.querySelector<HTMLElement>(".review-stream")!.scrollTop);

  await review!.reload();
  await expect(page.locator(".review-app")).not.toHaveAttribute(
    "data-generation",
    generation ?? "",
    { timeout: 30_000 },
  );
  const restored = await scrollTop();
  await page.keyboard.press("Space");
  // Outlast the restore window, so a pin still running would have undone the scroll.
  await page.waitForTimeout(1_200);

  expect(await scrollTop()).toBeGreaterThan(restored + 300);
});

test("has no serious accessibility violations", async ({ page }) => {
  await openTestReview(page);
  // Pierre's diff and tree internals are excluded: their contrast is the terminal theme's
  // own token pairing (changing it would break fidelity with the terminal), and the tree's
  // row labels omit the decoration text by Pierre's design. Everything the page draws runs.
  const results = await new AxeBuilder({ page })
    .exclude("diffs-container")
    .exclude("file-tree-container")
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(
      (violation) =>
        `${violation.id}: ${violation.nodes
          .map((node) => node.target.join(" "))
          .slice(0, 3)
          .join(", ")}`,
    );
  expect(serious).toEqual([]);
});

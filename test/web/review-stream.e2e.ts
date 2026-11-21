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
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  chooseTestTheme,
  openTestViewMenu,
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
  // A file with nothing to render says why in its header chip.
  await expect(page.locator('[data-empty-reason="rename-only"]')).toHaveText(
    "renamed, no content changes",
  );
  await expect(page.locator('[data-empty-reason="binary"]')).toHaveText(/^binary/);
  await expect(page.locator('[data-empty-reason="too-large"]')).toHaveText("too large");
  await expect(page.locator(".file-path", { hasText: "docs/日本語 ノート.md" })).toBeVisible();
  await expect(
    page.locator(".file-path", { hasText: "src/app/renamed-old.ts -> renamed-new.ts" }),
  ).toBeVisible();
});

// Intent: a header says what kind of change a file is in a chip instead of a body sentence;
// rename-only and binary files are header-only rows, a too-large file keeps one row saying why,
// and a file without line changes prints no `+0 −0`.
test("states each file's kind in its header", async ({ page }) => {
  await openTestReview(page);
  const section = (path: string) => page.locator(`section.file-section[aria-label="${path}"]`);

  await expect(section("docs/日本語 ノート.md").locator(".file-chip")).toHaveText("new");
  await expect(section("old/legacy.txt").locator(".file-chip")).toHaveText("deleted");
  await expect(section("src/app/main.ts").locator(".file-chip")).toHaveCount(0);
  await expect(section("old/legacy.txt").locator(".file-stats")).toHaveText("−2");

  const logo = section("assets/logo.svg");
  await logo.scrollIntoViewIfNeeded();
  await expect(logo.locator(".file-path")).toHaveText("assets/logo-old.svg -> logo.svg");
  await expect(logo.locator(".file-stats")).toHaveCount(0);
  await expect(logo.locator(".file-placeholder")).toHaveCount(0);
  await expect(logo.locator(".file-collapse")).toHaveCount(0);
  expect(
    await logo.locator(".file-body").evaluate((body) => (body as HTMLElement).offsetHeight),
  ).toBe(0);

  const image = section("assets/image.png");
  await expect(image.locator(".file-chip")).toHaveText(/^binary/);
  await expect(image.locator(".file-placeholder")).toHaveCount(0);

  const huge = section("data/huge.json");
  await huge.scrollIntoViewIfNeeded();
  await expect(huge.locator(".file-chip")).toHaveText("too large");
  await expect(huge.locator(".file-placeholder")).toHaveText(
    "File too large to render automatically.",
  );
});

// Intent: the chevron folds any file's body, viewed or not, without marking it; hunk
// navigation into a folded file opens it.
test("folds and unfolds a file from its header chevron", async ({ page }) => {
  await openTestReview(page);
  const main = page.locator('section.file-section[aria-label="src/app/main.ts"]');
  const chevron = main.locator(".file-collapse");

  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  await chevron.click();
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  await expect(main.locator(".file-body")).toHaveCount(0);
  await expect(main.locator(".viewed-toggle input")).not.toBeChecked();
  await chevron.press("Enter");
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  await expect(main.locator(".file-body")).toBeVisible();

  await chevron.click();
  await page.locator(".review-stream").focus();
  await page.keyboard.press("]");
  await page.keyboard.press("[");
  await expect(page.locator("section[data-selected]")).toHaveAttribute(
    "aria-label",
    "src/app/main.ts",
  );
  await expect(main.locator(".file-body")).toBeVisible();
});

// Intent: the header's copy button puts the file's path on the clipboard (the new path of a
// rename) and says so, the way the toolbar's copy link does.
test("copies a file's path from its header", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTestReview(page);
  const renamed = page.locator('section.file-section[aria-label="src/app/renamed-new.ts"]');
  const copy = renamed.locator(".file-copy-path");

  await expect(copy).toHaveCSS("opacity", "0");
  await renamed.locator(".file-header").hover();
  await expect(copy).toHaveCSS("opacity", "1");
  await copy.click();
  await expect(copy).toHaveAttribute("data-state", "copied");
  await expect(copy).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("src/app/renamed-new.ts");
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

// Intent: line counts group their digits and removals use a true minus, in the toolbar and
// the stream's file headers.
test("groups digits in line counts", async ({ page }) => {
  await openTestReview(page);

  await expect(page.locator(".toolbar-stats .stat-added")).toHaveText("+25,048");
  await expect(page.locator(".toolbar-stats .stat-removed")).toHaveText("−47");
  await expect(page.locator(".file-stats .stat-added", { hasText: "+24,999" })).toHaveCount(1);
});

// Intent: split view draws one "unchanged lines" row, with its count stated once.
test("draws one unchanged-lines row per gap in split view", async ({ page }) => {
  await openTestReview(page);
  const main = page.locator("section[data-file-key]").first();

  await page.getByTestId("layout-split").click();
  await expect(main.locator('.gap-separator[data-gap-id="before:0"]')).toHaveCount(1);
  await expect(main.locator(".gap-separator-fill").first()).toBeAttached();
  await expect(main.getByText("9 unchanged lines")).toHaveCount(1);

  await page.getByTestId("layout-unified").click();
  await expect(main.locator(".gap-separator-fill")).toHaveCount(0);
  await expect(main.locator('.gap-separator[data-gap-id="before:0"]')).toHaveCount(1);
});

// Intent: an "unchanged lines" row spans the diff in every layout, sits where its column does,
// and its words never widen the line-number gutter they are slotted into.
test("spans the diff with an unchanged-lines row and keeps the gutter narrow", async ({ page }) => {
  await openTestReview(page);
  const main = page.locator("section[data-file-key]").first();
  const host = main.locator(".pierre-host");
  const gap = main.locator('.gap-separator[data-gap-id="before:0"]').first();
  const fill = main.locator(".gap-separator-fill").first();
  const gutter = main.locator("[data-gutter]").first();
  const box = async (locator: Locator) =>
    (await locator.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };

  // How far a row is from covering `share` of the diff, starting `start` of the way across it:
  // the larger of its left edge's error and its width's.
  const offBy = async (locator: Locator, start: number, share: number) => {
    const [row, diff] = [await box(locator), await box(host)];
    return Math.max(
      Math.abs(row.x - (diff.x + diff.width * start)),
      Math.abs(row.width - diff.width * share),
    );
  };

  await page.getByTestId("layout-unified").click();
  await expect.poll(() => offBy(gap, 0, 1)).toBeLessThanOrEqual(2);
  expect((await box(gutter)).width * 4).toBeLessThan((await box(gap)).width);

  // Split view: each half covers its own column, so the pair covers the row.
  await page.getByTestId("layout-split").click();
  await expect.poll(() => offBy(gap, 0, 0.5)).toBeLessThanOrEqual(3);
  await expect.poll(() => offBy(fill, 0.5, 0.5)).toBeLessThanOrEqual(3);
  expect((await box(gutter)).width * 4).toBeLessThan((await box(gap)).width);

  // A narrow window makes the columns scroll. The row adds nothing to what scrolls (the
  // column is exactly as wide as its gutter plus its widest line) and stays put when it does.
  await page.setViewportSize({ width: 360, height: 900 });
  const column = main.locator("[data-code][data-deletions]");
  const scrolling = () =>
    column.evaluate((element) => {
      const track = (name: string) =>
        element.querySelector(`[${name}]`)?.getBoundingClientRect().width ?? 0;
      return {
        room: element.scrollWidth - element.clientWidth,
        excess: element.scrollWidth - (track("data-gutter") + track("data-content")),
        left: element.scrollLeft,
      };
    });
  await expect.poll(async () => (await scrolling()).room).toBeGreaterThan(20);
  await expect.poll(() => offBy(gap, 0, 0.5)).toBeLessThanOrEqual(3);
  expect((await scrolling()).excess).toBeLessThanOrEqual(1);
  await column.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(async () => (await scrolling()).left).toBeGreaterThan(20);
  expect(await offBy(gap, 0, 0.5)).toBeLessThanOrEqual(3);
  expect(await offBy(fill, 0.5, 0.5)).toBeLessThanOrEqual(3);
  expect((await scrolling()).excess).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Wrapped lines have no scrolling columns; the half with the words covers the whole row.
  await openTestViewMenu(page);
  await page.getByTestId("toggle-wrap").click();
  await expect.poll(() => offBy(gap, 0, 1)).toBeLessThanOrEqual(2);
  expect((await box(gutter)).width * 4).toBeLessThan((await box(host)).width);
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

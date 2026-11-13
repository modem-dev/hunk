/**
 * Drives the side panel's review tools against a rich live review.
 *
 * The Overview tab's figures must match the toolbar and the shared overview selector's policy,
 * and every row naming a file or a directory must jump the stream there. The panel opens by
 * default on wide viewports, toggles from the toolbar and its web-only shortcut, remembers its
 * state per browser, and passes axe — all without a CSP violation or console error.
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
  expect(problems).toEqual([]);
  await review?.stop();
  review = undefined;
});

/** Open the rich review and wait until every file has loaded. */
async function openTestReview(page: Page, options: TestWebReviewOptions = {}) {
  review = await startTestWebReview("--rich", options);
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** The file key of the stream's selected section. */
function selectedSectionPath(page: Page) {
  return page.locator("section[data-selected] .file-name").first();
}

test("opens the overview by default on a wide viewport and agrees with the toolbar", async ({
  page,
}) => {
  await openTestReview(page);
  const panel = page.getByTestId("side-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const files = await page.getByTestId("file-count").textContent();
  await expect(page.getByTestId("overview-total")).toContainText(files!);
  const added = await page.locator(".toolbar .stat-added").textContent();
  const removed = await page.locator(".toolbar .stat-removed").textContent();
  await expect(page.getByTestId("overview-total").locator(".stat-added")).toHaveText(added!);
  await expect(page.getByTestId("overview-total").locator(".stat-removed")).toHaveText(
    removed!.replace("-", "−"),
  );
  // The rich review is 47 files with forty small generated-module edits; its size is stated.
  await expect(panel.locator(".overview-size-letter")).toHaveText(/^(XS|S|M|L|XL)$/);
});

test("jumps to a file from the largest-files list and to a directory's first file", async ({
  page,
}) => {
  await openTestReview(page);
  const panel = page.getByTestId("side-panel");

  const largest = panel.locator(".overview-list .overview-name").nth(1);
  const path = (await largest.textContent())!;
  await largest.click();
  await expect(selectedSectionPath(page)).toContainText(path.split("/").at(-1)!);
  const section = page.locator("section[data-selected]");
  await expect(section).toBeInViewport();

  const directory = panel.locator(".overview-tree .overview-name", { hasText: "src/" }).first();
  await directory.click();
  await expect(page.locator("section[data-selected]")).toBeInViewport();
  await expect(selectedSectionPath(page)).toBeVisible();
});

test("toggles from the toolbar and its shortcut, and remembers the choice", async ({ page }) => {
  await openTestReview(page);
  const panel = page.getByTestId("side-panel");
  await expect(panel).toBeVisible();

  await page.getByTestId("toggle-side-panel").click();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveCount(0);

  await page.locator(".review-stream").focus();
  await page.keyboard.press("p");
  await expect(panel).toBeVisible();
  await page.keyboard.press("p");
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("Shift+O");
  await expect(panel).toBeVisible();
});

test("starts hidden on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openTestReview(page);
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await page.getByTestId("toggle-side-panel").click();
  await expect(page.getByTestId("side-panel")).toBeVisible();
});

test("counts notes by origin in the overview", async ({ page }) => {
  await openTestReview(page, {
    args: ["--agent-notes"],
    context: {
      "src/app/main.ts": {
        annotations: [{ newRange: [13, 13], summary: "Sidecar note", author: "sonnet" }],
      },
    },
  });
  const notes = page.getByTestId("overview-notes");
  await expect(notes).toBeVisible();
  const row = notes.locator("tbody tr", { hasText: "src/app/main.ts" });
  await expect(row.locator("td").first()).toHaveText("1");
  await row.getByRole("button").click();
  await expect(selectedSectionPath(page)).toContainText("main.ts");
});

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

test("lists notes by file and reveals the chosen one in the stream", async ({ page }) => {
  await openTestReview(page, {
    args: ["--agent-notes"],
    context: {
      "src/app/main.ts": {
        annotations: [{ newRange: [13, 13], summary: "Sidecar threshold note", author: "sonnet" }],
      },
    },
  });
  const root = await addTestComment([
    "--file",
    "src/gen/module-30.ts",
    "--new-line",
    "1",
    "--summary",
    "Far down the stream",
  ]);
  await addTestComment(["--reply-to", root, "--summary", "A reply to it"]);

  await page.getByTestId("side-panel-tab-notes").click();
  const panel = page.getByTestId("notes-panel");
  await expect(panel.locator(".notes-file-path")).toHaveText([
    "src/app/main.ts",
    "src/gen/module-30.ts",
  ]);
  await expect(panel.locator(".notes-count")).toHaveText("3 notes");
  await expect(panel.getByRole("button", { name: "▸ 1 reply" })).toBeVisible();

  await panel.getByTestId("notes-row").filter({ hasText: "Far down the stream" }).click();
  const card = page.locator(".note-card", { hasText: "Far down the stream" });
  await expect(card).toBeInViewport({ timeout: 15_000 });
  await expect(
    panel.getByTestId("notes-row").filter({ hasText: "Far down the stream" }),
  ).toHaveAttribute("aria-current", "true");

  await panel.getByTestId("notes-row").filter({ hasText: "Sidecar threshold note" }).click();
  await expect(page.locator(".note-card", { hasText: "Sidecar threshold note" })).toBeInViewport({
    timeout: 15_000,
  });

  // The panel's own filters: author and text, local to the tab.
  await panel.getByTestId("notes-origin-agent").click();
  await expect(panel.locator(".notes-none")).toHaveText("No notes match.");
  await panel.getByTestId("notes-origin-agent").click();
  await panel.getByRole("searchbox", { name: "Search notes" }).fill("threshold");
  await expect(panel.getByTestId("notes-row")).toHaveCount(1);
  await expect(panel.locator(".notes-count")).toHaveText("1 of 3 notes");
});

// Intent: a Notes-tab row reveals its card once; a later hunk jump in the same file lands on
// its own hunk instead of being pulled back to the clicked note.
test("lets a hunk jump after a Notes-tab reveal land on its own hunk", async ({ page }) => {
  await openTestReview(page, { args: ["--agent-notes"] });
  await addTestComment(["--file", "src/app/main.ts", "--new-line", "46", "--summary", "Late"]);
  await page.getByTestId("side-panel-tab-notes").click();
  await page.getByTestId("notes-row").filter({ hasText: "Late" }).click();
  await expect(page.locator(".note-card", { hasText: "Late" })).toBeInViewport();

  await page.locator(".review-stream").focus();
  await page.keyboard.press("[");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const rail = document.querySelector<HTMLElement>('[data-testid="selected-hunk"]');
        const header = document.querySelector<HTMLElement>("section[data-selected] .file-header");
        if (!rail || !header || rail.dataset.hunkIndex !== "0") return false;
        const gap = rail.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
        return gap >= 0 && gap <= 20;
      }),
    )
    .toBe(true);
});

// Intent: the panel's edge is a keyboard-operable window splitter, and a drag the browser
// cancels stops following the pointer.
test("resizes the panel from the keyboard and ends a cancelled drag", async ({ page }) => {
  await openTestReview(page);
  const resizer = page.getByTestId("side-panel-resizer");
  await expect(resizer).toHaveAttribute("aria-valuemin", "260");
  await expect(resizer).toHaveAttribute("aria-valuemax", "640");
  const width = async () => Number(await resizer.getAttribute("aria-valuenow"));
  const start = await width();

  await resizer.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBe(start + 16);
  await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBe(start);
  await page.keyboard.press("End");
  await expect.poll(width).toBe(640);
  await page.keyboard.press("Home");
  await expect.poll(width).toBe(260);

  const box = (await resizer.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x - 40, box.y + 100, { steps: 4 });
  const dragged = await width();
  expect(dragged).toBeGreaterThan(260);
  await resizer.dispatchEvent("pointercancel");
  await page.mouse.move(box.x - 200, box.y + 100, { steps: 4 });
  expect(await width()).toBe(dragged);
  await page.mouse.up();
});

test("explains how notes arrive when there are none", async ({ page }) => {
  await openTestReview(page);
  await page.locator(".review-stream").focus();
  await page.keyboard.press("Shift+N");
  await expect(page.getByTestId("notes-empty")).toContainText("hunk session comment add");
});

test("has no serious accessibility violations with the panel open", async ({ page }) => {
  await openTestReview(page);
  await expect(page.getByTestId("side-panel")).toBeVisible();
  await page.locator(".overview-disclosure[aria-expanded]").first().click();
  const overviewResults = await new AxeBuilder({ page })
    .exclude("diffs-container")
    .exclude("file-tree-container")
    .analyze();
  await page.getByTestId("side-panel-tab-notes").click();
  const notesResults = await new AxeBuilder({ page })
    .exclude("diffs-container")
    .exclude("file-tree-container")
    .analyze();
  const serious = [...overviewResults.violations, ...notesResults.violations]
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`,
    );
  expect(serious).toEqual([]);
});

/** The stream's scroll position as a fraction of its range. */
function streamScrollFraction(page: Page) {
  return page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    return stream.scrollTop / Math.max(1, stream.scrollHeight - stream.clientHeight);
  });
}

test("the minimap scrolls the stream on click and drag and follows it back", async ({ page }) => {
  await openTestReview(page);
  const minimap = page.getByTestId("minimap");
  await expect(minimap).toBeVisible();
  const box = (await minimap.boundingBox())!;

  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.9);
  await expect.poll(() => streamScrollFraction(page)).toBeGreaterThan(0.6);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.9);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => streamScrollFraction(page)).toBeLessThan(0.35);

  // Scrolling the stream itself moves the viewport window.
  const windowTop = () =>
    page.getByTestId("minimap-window").evaluate((element) => element.getBoundingClientRect().top);
  const before = await windowTop();
  await page.locator(".review-stream").focus();
  await page.keyboard.press("G");
  await expect.poll(windowTop).toBeGreaterThan(before + 20);

  // A layout switch reflows the stream; the window still spans part of the track.
  await page.getByTestId("layout-unified").click();
  await expect
    .poll(() =>
      page
        .getByTestId("minimap-window")
        .evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(5);
});

/** How far the minimap's projected stream height is from the stream's real height. */
function minimapHeightDrift(page: Page) {
  return page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    const minimap = document.querySelector<HTMLElement>('[data-testid="minimap"]')!;
    return Number(minimap.dataset.streamHeight) - stream.scrollHeight;
  });
}

// Intent: the minimap follows the stream's height when it changes without a scroll, as when a
// viewed file collapses.
test("the minimap repaints when a file collapses without a scroll", async ({ page }) => {
  await openTestReview(page);
  await expect(page.getByTestId("minimap")).toBeVisible();
  await page.waitForTimeout(500);
  const drift = await minimapHeightDrift(page);

  await page.locator("section[data-file-key]").first().locator(".viewed-toggle input").click();
  await expect(page.locator(".file-collapsed").first()).toBeVisible();

  await expect.poll(() => minimapHeightDrift(page)).toBeLessThanOrEqual(drift + 2);
  expect(await minimapHeightDrift(page)).toBeGreaterThanOrEqual(drift - 2);
});

// Intent: the reader's own minimap scroll ends a jump-to-end hold, and a reload during that
// hold replaces it rather than leaving it pulling to the edge.
test("the minimap and a reload both end a jump-to-end hold", async ({ page }) => {
  await openTestReview(page);
  const minimap = page.getByTestId("minimap");
  const box = (await minimap.boundingBox())!;
  await page.locator(".review-stream").focus();
  await page.keyboard.press("Shift+G");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.1);
  await page.waitForTimeout(1_300);
  expect(await streamScrollFraction(page)).toBeLessThan(0.35);

  const distanceFromEnd = () =>
    page.evaluate(() => {
      const stream = document.querySelector<HTMLElement>(".review-stream")!;
      return stream.scrollHeight - stream.clientHeight - stream.scrollTop;
    });
  const generation = await page.locator(".review-app").getAttribute("data-generation");
  // Keys from the page, not the focused stream, whose own key input would end the hold.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Shift+G");
  // The end keeps moving, as files below still drawing make it, so the hold is still running
  // when the reload lands.
  await page.evaluate(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      const sections = document.querySelectorAll<HTMLElement>("section[data-file-key]");
      const grown = document.createElement("div");
      grown.style.height = "20px";
      sections[sections.length - 1]?.append(grown);
      if (Date.now() - started > 4_500) clearInterval(timer);
    }, 150);
  });
  await review!.reload();
  await expect(page.locator(".review-app")).not.toHaveAttribute(
    "data-generation",
    generation ?? "",
    { timeout: 30_000 },
  );
  await page.keyboard.press("u");
  await page.waitForTimeout(1_300);
  expect(await distanceFromEnd()).toBeGreaterThan(100);
});

test("the minimap hides on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 800 });
  await openTestReview(page);
  await expect(page.getByTestId("minimap")).toHaveCount(0);
});

test("the minimap stays cheap and accurate on a 2,000-file review", async ({ page }) => {
  test.setTimeout(180_000);
  review = await startTestWebReview("--many=2000");
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.getByTestId("file-count")).toHaveText("2000 files", { timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 120_000 });
  const minimap = page.getByTestId("minimap");
  const box = (await minimap.boundingBox())!;

  const started = Date.now();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 2);
  await expect.poll(() => streamScrollFraction(page)).toBeGreaterThan(0.97);
  expect(Date.now() - started).toBeLessThan(3_000);
  // Repainting the whole track on scroll stays well under a frame budget: the minimap's own
  // work, measured by the mark it records, not the stream's mounting around it.
  const paintMs = await page.evaluate(async () => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    performance.clearMeasures("hunk-minimap-redraw");
    for (let step = 0; step < 20; step += 1) {
      stream.scrollTop = (stream.scrollHeight * step) / 20;
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
    const durations = performance
      .getEntriesByName("hunk-minimap-redraw")
      .map((entry) => entry.duration)
      .sort((left, right) => left - right);
    return durations[Math.floor(durations.length / 2)] ?? 0;
  });
  // The median, so one repaint delayed by a busy test machine does not decide the result.
  expect(paintMs).toBeLessThan(16);
});

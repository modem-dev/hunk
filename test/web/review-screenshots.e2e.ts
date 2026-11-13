/**
 * Captures the review page in the states a reviewer judges fidelity by.
 *
 * Opt-in: runs only when `HUNK_WEB_SCREENSHOT_DIR` names a directory, and writes one PNG per
 * state there at device scale 2. Not an assertion suite — the other `*.e2e.ts` files are.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { chooseTestTheme, startTestWebReview, type TestWebReview } from "./webTestHarness";

const OUTPUT = process.env.HUNK_WEB_SCREENSHOT_DIR;

test.skip(!OUTPUT, "Set HUNK_WEB_SCREENSHOT_DIR to capture screenshots.");
test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

let review: TestWebReview | undefined;

test.afterEach(async () => {
  await review?.stop();
  review = undefined;
});

/** Let lazy grammars, themes, and mounts settle before a capture. */
async function settle(page: Page) {
  await page.waitForTimeout(1_200);
}

/** Save one capture. */
async function capture(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: join(OUTPUT!, `${name}.png`) });
}

/** Open the rich review with a stored theme and layout already chosen. */
async function openRich(page: Page, themeId: string, layout: "split" | "unified" | "auto") {
  await page.addInitScript(
    ([theme, view]) => {
      window.localStorage.setItem("hunk.review.theme", theme);
      window.localStorage.setItem("hunk.review.view", view);
    },
    [themeId, JSON.stringify({ layout })] as const,
  );
  await page.goto(review!.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
}

test("captures the review page for visual review", async ({ page, browser }) => {
  test.setTimeout(240_000);
  mkdirSync(OUTPUT!, { recursive: true });
  review = await startTestWebReview("--rich");

  await openRich(page, "github-dark-default", "split");
  await capture(page, "01-split-github-dark");
  await page.getByTestId("layout-unified").click();
  await capture(page, "02-unified-github-dark");

  const gap = page.locator(".gap-separator").first();
  await gap.click();
  await page
    .locator('.gap-separator[data-gap-state="loading"]')
    .waitFor({ state: "detached" })
    .catch(() => undefined);
  await capture(page, "03-expanded-gap");

  // The second hunk of the first file selected from the keyboard: the accent rail, revealed
  // under the sticky header.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("]");
  await capture(page, "10-selected-hunk-mid-file");

  await chooseTestTheme(page, "github-light-default");
  await page.getByTestId("layout-split").click();
  await capture(page, "04-split-github-light");
  await settle(page);
  await page.screenshot({
    path: join(OUTPUT!, "11-toolbar-light.png"),
    clip: { x: 0, y: 0, width: 1440, height: 48 },
  });
  await page.getByTestId("theme-picker").click();
  await page.screenshot({
    path: join(OUTPUT!, "12-theme-menu-light.png"),
    clip: { x: 840, y: 0, width: 600, height: 520 },
  });
  await page.keyboard.press("Escape");
  await chooseTestTheme(page, "dracula");
  await capture(page, "05-split-dracula");
  await chooseTestTheme(page, "solarized-light");
  await capture(page, "06-split-solarized-light");

  await page
    .locator('section[data-file-key]:has([data-empty-reason="binary"])')
    .scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    const section = document.querySelector<HTMLElement>(
      'section[data-file-key]:has([data-empty-reason="rename-only"])',
    )!;
    stream.scrollTop = section.offsetTop - 120;
  });
  await capture(page, "07-placeholders");

  await page.getByTestId("toggle-sidebar").click();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".review-stream")!.scrollTop = 0;
  });
  await capture(page, "08-sidebar-collapsed");

  const narrow = await browser.newPage({
    deviceScaleFactor: 2,
    viewport: { width: 800, height: 900 },
  });
  await narrow.addInitScript(() =>
    window.localStorage.setItem("hunk.review.theme", "github-dark-default"),
  );
  await narrow.goto(review.url);
  await expect(narrow.locator('.toolbar [data-state="connected"]')).toBeVisible({
    timeout: 30_000,
  });
  await capture(narrow, "09-narrow-800");
  await narrow.close();
});

test("captures notes, markup, highlights, and the session title", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(OUTPUT!, { recursive: true });
  review = await startTestWebReview("--rich", {
    args: ["--agent-notes", "--experimental"],
    context: {
      "src/app/main.ts": {
        summary: "Raises the threshold and adds a formatter.",
        annotations: [
          {
            newRange: [45, 47],
            summary: "describe() is new.",
            markup:
              '<box border title="Formatter" border-color="accent"><text><badge color="success">new</badge> <b>describe(value)</b> renders a label</text><list><item>pure, no I/O</item><item>covered by <kbd>describe.test.ts</kbd></item></list></box>',
          },
        ],
      },
    },
  });
  await openRich(page, "github-dark-default", "split");
  const hunk = review.hunk;
  const added = JSON.parse(
    await hunk([
      "session",
      "comment",
      "add",
      review.sessionId,
      "--file",
      "src/app/main.ts",
      "--new-line",
      "13",
      "--summary",
      "The threshold doubles; is 10 still right for small inputs?",
      "--rationale",
      "Callers with fewer than ten items now skip the fast path entirely.",
      "--author",
      "opus",
      "--json",
    ]),
  ) as { result: { commentId: string; hunkIndex: number } };
  const state = (await review.readApi("state")).state as {
    notes: { note: { id: string; fileKey: string } }[];
  };
  const parent = state.notes.find((entry) => entry.note.id === added.result.commentId)!.note;
  await review.postAction({
    type: "notes/add-user",
    fileKey: parent.fileKey,
    hunkIndex: added.result.hunkIndex,
    parentId: parent.id,
    body: "Yes: the benchmark in #812 shows the fast path only pays off from ten items.",
  });
  await expect(
    page.locator(".note-card", { hasText: "the fast path only pays off" }),
  ).toBeVisible();
  await capture(page, "13-notes-thread-dark");
  await chooseTestTheme(page, "github-light-default");
  await capture(page, "14-notes-thread-light");
  await chooseTestTheme(page, "github-dark-default");

  await page.locator(".note-card .stml").scrollIntoViewIfNeeded();
  await capture(page, "15-stml-note");

  for (const [line, start, end, tone] of [
    ["45", "16", "24", "warning"],
    ["13", "13", "22", "current"],
  ] as const) {
    await hunk([
      "session",
      "highlight",
      "add",
      review.sessionId,
      "--file",
      "src/app/main.ts",
      "--new-line",
      line,
      "--start",
      start,
      "--end",
      end,
      "--tone",
      tone,
    ]);
  }
  await expect(page.locator(".agent-highlight")).toHaveCount(2);
  await page.locator(".agent-highlight").first().scrollIntoViewIfNeeded();
  await capture(page, "16-agent-highlights");

  // No host path marks a note stale today, so the page's stale treatment is captured from a
  // shared-state response rewritten in flight; the next comment makes the page refetch it.
  await page.route("**/state", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      state: { notes: { note: { summary: string }; resolution: string }[] };
    };
    for (const entry of body.state.notes) {
      if (entry.note.summary.startsWith("Rename this")) entry.resolution = "stale";
    }
    await route.fulfill({ response, json: body });
  });
  await hunk([
    "session",
    "comment",
    "add",
    review.sessionId,
    "--file",
    "src/gen/module-00.ts",
    "--new-line",
    "2",
    "--summary",
    "Rename this label before the release.",
    "--author",
    "opus",
  ]);
  await page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    const section = Array.from(
      document.querySelectorAll<HTMLElement>("section[data-file-key]"),
    ).find((candidate) => candidate.textContent?.includes("src/gen/module-00.ts"))!;
    stream.scrollTop = section.offsetTop - 200;
  });
  await expect(page.locator(".note-card[data-stale]")).toHaveCount(1, { timeout: 30_000 });
  await capture(page, "17-stale-note");

  await settle(page);
  await page.screenshot({
    path: join(OUTPUT!, "18-toolbar-title.png"),
    clip: { x: 0, y: 0, width: 1440, height: 48 },
  });
});

test("captures writing notes, the shared filter, and an error toast", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(OUTPUT!, { recursive: true });
  review = await startTestWebReview("--rich");
  await openRich(page, "github-dark-default", "unified");
  const main = page.locator("section[data-file-key]").first();

  await main.locator('[data-column-number="14"]').first().hover();
  await page.mouse.down();
  await main.locator('[data-column-number="16"]').first().hover();
  await page.mouse.up();
  await page
    .locator(".note-composer textarea")
    .fill("These three exports always change together; worth one comment above them.");
  await capture(page, "19-composer-line-range");

  await page.locator(".note-composer textarea").press("Control+Enter");
  const saved = page.locator(".note-card", { hasText: "always change together" });
  await expect(saved).toBeVisible({ timeout: 15_000 });
  await saved.hover();
  await capture(page, "20-saved-note-actions");

  await saved.getByRole("button", { name: /^Reply/ }).click();
  await page.locator(".note-composer textarea").fill("Agreed.");
  await page.locator(".note-composer textarea").press("Control+Enter");
  await expect(page.locator(".note-card", { hasText: "Agreed." })).toBeVisible();
  await saved.getByRole("button", { name: /^Delete/ }).click();
  await expect(page.getByTestId("toasts")).not.toBeEmpty();
  await capture(page, "21-error-toast");

  await page.getByTestId("filter-input").fill("module-1");
  await expect(page.getByTestId("shared-filter")).toBeVisible();
  await capture(page, "22-filter-in-use");
});

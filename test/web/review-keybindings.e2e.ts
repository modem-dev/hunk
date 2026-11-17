/**
 * Checks that a user's `[keybindings]` remap reaches the browser review page the way it reaches
 * the terminal: every hint for a remapped command shows the new key and not the default, the
 * new key performs the command, and the old default no longer does.
 *
 * The test chooses its own keys and reads each command's default from the shared catalog, so
 * it names no key it did not pick. Every step passes without a CSP violation or console error.
 */
import { expect, test, type Page } from "@playwright/test";
import { APP_COMMAND_CATALOG } from "../../packages/hunk/src/core/run/commandCatalog";
import { formatKeyChord } from "../../packages/hunk/src/core/run/keyChordLabels";
import { WEB_LOCAL_COMMANDS } from "../../packages/hunk/src/web/commands/webLocalCommands";
import {
  openTestViewMenu,
  startTestWebReview,
  watchTestPageProblems,
  type TestWebReview,
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

/** The keys this test binds, by command id. */
const REMAPS = {
  "hunk.review.nextHunk": "n",
  "hunk.view.toggleLineWrap": "W",
  "hunk.review.replyToActiveNote": "K",
  "hunk.web.toggleViewed": "x",
  "hunk.web.toggleHideViewed": "H",
} as const;

/** The config the session starts with: the remaps above as a `[keybindings]` table. */
function remapTestConfig(ids: readonly (keyof typeof REMAPS)[]) {
  return ["[keybindings]", ...ids.map((id) => `"${id}" = "${REMAPS[id]}"`), ""].join("\n");
}

/** One command's first default chord, from the catalog or the page's own command list. */
function defaultTestChord(id: string) {
  const catalog = APP_COMMAND_CATALOG.find((entry) => entry.id === id);
  const local = WEB_LOCAL_COMMANDS.find((entry) => entry.id === id);
  const chord = catalog?.defaultKeys[0] ?? (local && "keys" in local ? local.keys[0] : undefined);
  if (!chord) throw new Error(`${id} ships no default key to compare with`);
  return chord;
}

/** Open the rich review with a remapping config and wait until every file has loaded. */
async function openTestReview(page: Page, config: string) {
  review = await startTestWebReview("--rich", { config, args: ["--agent-notes"] });
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("selected-hunk")).toBeVisible({ timeout: 15_000 });
  await page.locator(".review-stream").focus();
}

/** The selected hunk, as the stream's rail names it. */
function selectedHunk(page: Page) {
  return page.locator('[data-testid="selected-hunk"]').getAttribute("data-hunk-index");
}

/** Where the selection is: its file and hunk. */
async function selectedPlace(page: Page) {
  const path = await page.locator("section[data-selected]").getAttribute("aria-label");
  return `${path}#${await selectedHunk(page)}`;
}

test("a remapped catalog command shows and answers to its new key everywhere", async ({ page }) => {
  await openTestReview(
    page,
    remapTestConfig([
      "hunk.review.nextHunk",
      "hunk.view.toggleLineWrap",
      "hunk.review.replyToActiveNote",
    ]),
  );
  const nextHunk = formatKeyChord(REMAPS["hunk.review.nextHunk"]);
  const nextHunkDefault = formatKeyChord(defaultTestChord("hunk.review.nextHunk"));
  const wrap = formatKeyChord(REMAPS["hunk.view.toggleLineWrap"]);
  const wrapDefault = formatKeyChord(defaultTestChord("hunk.view.toggleLineWrap"));
  const reply = formatKeyChord(REMAPS["hunk.review.replyToActiveNote"]);
  const replyDefault = formatKeyChord(defaultTestChord("hunk.review.replyToActiveNote"));

  // The review bar's hunk hint carries the new key, not the default.
  const hunkHint = page.locator('[data-testid="bar-key-hints"] [data-hint="hunk"] kbd');
  await expect(hunkHint.last()).toHaveText(nextHunk);
  await expect(hunkHint).not.toContainText([nextHunkDefault]);

  // The new key moves to the next hunk; the old default no longer does.
  const start = await selectedPlace(page);
  await page.keyboard.press(nextHunkDefault);
  await page.waitForTimeout(300);
  expect(await selectedPlace(page)).toBe(start);
  await page.keyboard.press(nextHunk);
  await expect.poll(() => selectedPlace(page)).not.toBe(start);

  // The View menu's wrap row names the new key, and the key toggles wrapping.
  await openTestViewMenu(page);
  const wrapRow = page.getByTestId("toggle-wrap");
  await expect(wrapRow.locator(".key-hint")).toHaveText(wrap);
  const wrapped = await wrapRow.getAttribute("aria-checked");
  await page.keyboard.press("Escape");
  await page.locator(".review-stream").focus();
  await page.keyboard.press(wrapDefault);
  await openTestViewMenu(page);
  await expect(wrapRow).toHaveAttribute("aria-checked", wrapped!);
  await page.keyboard.press("Escape");
  await page.locator(".review-stream").focus();
  await page.keyboard.press(wrap);
  await openTestViewMenu(page);
  await expect(wrapRow).toHaveAttribute("aria-checked", wrapped === "true" ? "false" : "true");
  await page.keyboard.press("Escape");

  // A note's reply action names the new key.
  await review!.hunk([
    "session",
    "comment",
    "add",
    review!.sessionId,
    "--file",
    "src/app/main.ts",
    "--new-line",
    "13",
    "--summary",
    "Remapped reply",
  ]);
  const card = page.locator(".note-card", { hasText: "Remapped reply" });
  const replyAction = card.locator('[data-note-action="reply"]');
  await expect(replyAction).toHaveAttribute("aria-label", `Reply (${reply})`);
  await expect(replyAction).not.toHaveAttribute("aria-label", new RegExp(`\\(${replyDefault}\\)`));
});

// Intent: a page-only command (`hunk.web.*`) is remapped like any other. The host resolves the
// entry and publishes it in the page's keymap, so every hint and the help overlay name the new
// key, the new key runs the command, and the default it replaced does nothing.
test("a remapped page-only command shows and answers to its new key", async ({ page }) => {
  await openTestReview(page, remapTestConfig(["hunk.web.toggleViewed"]));
  const viewed = formatKeyChord(REMAPS["hunk.web.toggleViewed"]);
  const viewedDefault = formatKeyChord(defaultTestChord("hunk.web.toggleViewed"));
  const title = WEB_LOCAL_COMMANDS.find((entry) => entry.id === "hunk.web.toggleViewed")!.title;

  const barHint = page.locator('[data-testid="bar-key-hints"] [data-hint="viewed"] kbd');
  const headerHint = page.locator("section[data-selected] .viewed-toggle .key-hint");
  const checkbox = page.locator("section[data-selected] .viewed-toggle input");
  await expect(barHint).toHaveText(viewed, { timeout: 5_000 });
  await expect(headerHint).toHaveText(viewed, { timeout: 5_000 });

  // The help overlay lists the command under the new key alone.
  await page.keyboard.press(formatKeyChord(defaultTestChord("hunk.app.toggleHelp")));
  const help = page.getByTestId("help-overlay");
  const helpRow = help.getByRole("row", { name: new RegExp(title, "i") });
  await expect(helpRow.locator("kbd")).toHaveText(viewed);
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await page.locator(".review-stream").focus();

  await page.keyboard.press(viewedDefault);
  await page.waitForTimeout(300);
  await expect(checkbox).not.toBeChecked();
  await page.keyboard.press(viewed);
  await expect(checkbox).toBeChecked({ timeout: 5_000 });
});

// Intent: a page command that ships without a key takes one from `[keybindings]`, as an unbound
// catalog command does: the View menu's row names it and the key runs the command.
test("a page-only command that ships unbound takes a key from the config", async ({ page }) => {
  const hideViewed = formatKeyChord(REMAPS["hunk.web.toggleHideViewed"]);
  await openTestReview(page, remapTestConfig(["hunk.web.toggleHideViewed"]));

  await openTestViewMenu(page);
  const row = page.getByTestId("toggle-hide-viewed");
  await expect(row.locator(".key-hint")).toHaveText(hideViewed);
  await expect(row).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await page.locator(".review-stream").focus();

  await page.keyboard.press(hideViewed);
  await openTestViewMenu(page);
  await expect(row).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
});

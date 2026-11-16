/**
 * Drives the page's writing side against a real headless session.
 *
 * Covers the note lifecycle from the keyboard and the mouse (create, edit, reply, delete,
 * cancel), confirmed by the agent's own `hunk session comment list`; a line-range note from a
 * drag in the gutter and a one-line note inside an expanded gap, which travels with the
 * expansion proof; drafts surviving a tab reload; the shared filter and agent-note visibility
 * reaching a second page on the same session; refresh after a file edit; the capability leaving
 * the address bar while the tab keeps working; and the `too-many-notes` and stale-generation
 * error paths.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  // Check the page before stopping (a stopped daemon cuts its event stream), but stop even when
  // the check fails, so a page problem never leaves the daemon and session running.
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

/** The notes the session holds, as the agent's own CLI lists them. */
async function listTestNotes() {
  const output = await review!.hunk([
    "session",
    "comment",
    "list",
    review!.sessionId,
    "--type",
    "all",
    "--json",
  ]);
  return JSON.stringify(JSON.parse(output));
}

/** The first file's section. */
function mainSection(page: Page) {
  return page.locator("section[data-file-key]").first();
}

/** The note card with one summary. */
function noteCard(page: Page, summary: string) {
  return page.locator(".note-card", { hasText: summary });
}

/** Type into the open composer and save it with the save chord. */
async function writeAndSave(page: Page, text: string) {
  const composer = page.locator(".note-composer").last();
  await composer.locator("textarea").fill(text);
  await composer.locator("textarea").press("Control+Enter");
  await expect(page.locator(".note-composer")).toHaveCount(0, { timeout: 15_000 });
}

test("creates, edits, replies to, and deletes reviewer notes", async ({ page }) => {
  await openTestReview(page);

  await page.keyboard.press("c");
  await expect(page.locator(".note-composer")).toBeVisible();
  await expect(page.locator(".composer-hint")).toContainText("Enter to save");
  await writeAndSave(page, "Threshold needs a comment.");
  const card = noteCard(page, "Threshold needs a comment.");
  await expect(card).toBeVisible();
  await expect(card.locator(".note-author")).toHaveText(/^Browser note/);
  expect(await listTestNotes()).toContain("Threshold needs a comment.");

  // Edit from the card.
  await card.getByRole("button", { name: /^Edit/ }).click();
  await writeAndSave(page, "Threshold needs a short comment.");
  await expect(noteCard(page, "Threshold needs a short comment.")).toBeVisible();
  await expect.poll(listTestNotes).toContain("Threshold needs a short comment.");

  // Reply from the keyboard to the active note.
  await noteCard(page, "Threshold needs a short comment.").click();
  await page.keyboard.press("Shift+R");
  await writeAndSave(page, "Added one.");
  await expect(noteCard(page, "Added one.")).toHaveAttribute("data-depth", "1");

  // A note with replies is refused by the session, with its sentence.
  await noteCard(page, "Threshold needs a short comment.")
    .getByRole("button", { name: /^Delete/ })
    .click();
  await expect(page.getByTestId("toasts")).toContainText(
    "That note still has replies attached to it.",
  );
  // The reply itself goes with `D`.
  await noteCard(page, "Added one.").click();
  await page.keyboard.press("Shift+D");
  await expect(noteCard(page, "Added one.")).toHaveCount(0);
  await expect.poll(listTestNotes).not.toContain("Added one.");

  // Esc on an empty composer cancels at once; with text it asks first.
  await page.keyboard.press("c");
  await page.locator(".note-composer textarea").press("Escape");
  await expect(page.locator(".note-composer")).toHaveCount(0);
  await page.keyboard.press("c");
  await page.locator(".note-composer textarea").fill("half a thought");
  await page.locator(".note-composer textarea").press("Escape");
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.locator(".note-composer")).toHaveCount(0);
});

test("writes a range note from the gutter and a line note inside an expanded gap", async ({
  page,
}) => {
  await openTestReview(page);
  const main = mainSection(page);

  // Drag across the line numbers of three context rows.
  await main.locator('[data-column-number="14"]').first().hover();
  await page.mouse.down();
  await main.locator('[data-column-number="16"]').first().hover();
  await page.mouse.up();
  await expect(page.locator(".note-composer .note-range")).toHaveText("R14–R16");
  await writeAndSave(page, "These three lines move together.");
  await expect(
    noteCard(page, "These three lines move together.").locator(".note-range"),
  ).toHaveText("R14–R16");

  // Expand the leading gap, then use the hover affordance on a line only the expansion drew.
  await main.locator('.gap-separator[data-gap-id="before:0"]').first().click();
  await expect(main.locator('[data-column-number="3"]').first()).toBeVisible({ timeout: 15_000 });
  await main.locator('[data-line="3"]').last().hover();
  await main.locator("[data-utility-button]").click();
  await expect(page.locator(".note-composer .note-range")).toHaveText("R3");
  await writeAndSave(page, "Expanded context note.");
  await expect(noteCard(page, "Expanded context note.")).toBeVisible();
  await expect.poll(listTestNotes).toContain("Expanded context note.");
});

test("keeps unsent drafts across a tab reload", async ({ page }) => {
  await openTestReview(page);
  await page.keyboard.press("c");
  await page.locator(".note-composer textarea").fill("Survives a reload.");
  await page.reload();
  await expect(page.locator(".note-composer textarea")).toHaveValue("Survives a reload.", {
    timeout: 30_000,
  });
  await page.locator(".note-composer textarea").press("Control+Enter");
  await expect(noteCard(page, "Survives a reload.")).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(noteCard(page, "Survives a reload.")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".note-composer")).toHaveCount(0);
});

test("shares the filter and note visibility with a second page", async ({ page, context }) => {
  await openTestReview(page);
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
    "An agent note.",
  ]);
  const other = await context.newPage();
  const otherProblems = await watchTestPageProblems(other);
  await other.goto(review!.url);
  await expect(noteCard(other, "An agent note.")).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press("/");
  await expect(page.getByTestId("filter-input")).toBeFocused();
  await page.keyboard.type("module-1");
  await expect(other.getByTestId("shared-filter")).toHaveText("filter: module-1");
  await expect(other.locator("section[data-file-key]")).toHaveCount(10);
  await expect(other.getByTestId("file-count")).toHaveText("10 files");
  // A filter that matches nothing counts nothing, not the whole review.
  await page.getByTestId("filter-input").fill("no-such-file");
  await expect(other.locator("section[data-file-key]")).toHaveCount(0);
  await expect(other.getByTestId("file-count")).toHaveText("0 files");
  await page.getByTestId("filter-input").fill("");
  await expect(other.getByTestId("shared-filter")).toHaveCount(0);

  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("a");
  await expect(noteCard(other, "An agent note.")).toHaveCount(0);
  await page.keyboard.press("a");
  await expect(noteCard(other, "An agent note.")).toBeVisible();
  expect(otherProblems).toEqual([]);
});

test("refreshes the review after a file changes", async ({ page }) => {
  await openTestReview(page);
  const generation = await page.locator(".review-app").getAttribute("data-generation");
  const path = join(review!.repo!, "src", "app", "main.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace("line10 = 10;", "line10 = 1010;"));
  execFileSync("git", ["add", "-A"], { cwd: review!.repo!, stdio: "ignore" });
  await page.getByTestId("refresh").click();
  await expect(page.locator(".review-app")).not.toHaveAttribute(
    "data-generation",
    generation ?? "",
    {
      timeout: 30_000,
    },
  );
  await expect(mainSection(page).locator("diffs-container")).toContainText("1010");
});

test("moves the capability out of the address and keeps working after a reload", async ({
  page,
}) => {
  await openTestReview(page);
  expect(page.url()).not.toContain("capability");
  await page.reload();
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  expect(page.url()).not.toContain("capability");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("copy-link").click();
  await expect(page.getByTestId("copy-link")).toHaveText("Copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // The full link: this review's address and capability, plus where the reader is.
  const copiedUrl = new URL(copied);
  const printedUrl = new URL(review!.url);
  expect(copiedUrl.origin + copiedUrl.pathname).toBe(printedUrl.origin + printedUrl.pathname);
  expect(new URLSearchParams(copiedUrl.hash.slice(1)).get("capability")).toBe(
    new URLSearchParams(printedUrl.hash.slice(1)).get("capability"),
  );

  // A fresh tab with neither the fragment nor this tab's storage cannot reach the review.
  const bare = await page.context().newPage();
  await bare.goto(review!.url.replace(/#.*$/, ""));
  await expect(bare.getByRole("alert")).toContainText("hunk session open");
  await bare.close();
});

test("reports too-many-notes and retries a stale generation", async ({ page }) => {
  await openTestReview(page);
  // Fill the review's note budget to its count bound (4,000) from the agent side.
  for (let batch = 0; batch < 2; batch += 1) {
    await review!.hunk(
      ["session", "comment", "apply", review!.sessionId, "--stdin"],
      JSON.stringify({
        comments: Array.from({ length: 2_000 }, (_unused, index) => ({
          filePath: `src/gen/module-${String(index % 40).padStart(2, "0")}.ts`,
          newLine: 2,
          summary: `n${batch}-${index}`,
        })),
      }),
    );
  }
  await page.keyboard.press("c");
  await page.locator(".note-composer textarea").fill("One too many.");
  await page.locator(".note-composer textarea").press("Control+Enter");
  await expect(page.locator(".note-composer [role=alert]")).toContainText(
    "as many notes as Hunk can store",
  );
  await page.locator(".note-composer").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Discard" }).click();
  await review!.hunk(["session", "comment", "clear", review!.sessionId, "--yes"]);

  // The next note send meets a stale generation while the session reloads, which edits
  // `src/app/main.ts` and leaves every other file as it was.
  let refusals = 0;
  let refuseNext = true;
  await page.route("**/actions", async (route) => {
    const body = route.request().postDataJSON() as { action: { type: string } };
    if (!refuseNext || body.action.type !== "notes/add-user") return route.continue();
    refuseNext = false;
    refusals += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "stale-generation", message: "stale" }),
    });
    await review!.reload();
  });

  // A note on the file the reload changed is not sent again: its lines moved.
  await page.keyboard.press("c");
  await page.locator(".note-composer textarea").fill("Written before the edit.");
  await page.locator(".note-composer textarea").press("Control+Enter");
  await expect(page.locator(".note-composer [role=alert]")).toContainText(
    "The review changed after this request was prepared.",
  );
  await page.locator(".note-composer").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Discard" }).click();

  // A note on an unchanged file waits for the reload and is sent again.
  refuseNext = true;
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(".");
  await page.keyboard.press("c");
  await writeAndSave(page, "Sent after the reload.");
  await expect(noteCard(page, "Sent after the reload.")).toBeVisible();
  await expect.poll(listTestNotes).toContain("src/app/renamed-new.ts");
  expect(refusals).toBe(2);
});

// The byte bound, reached the way a reviewer would: large browser notes. Before session wire
// v22 any note above 4,096 bytes disconnected the session, so this variant was unreachable.
test("reports too-many-notes at the stored-note byte bound", async ({ page }) => {
  await openTestReview(page);
  const state = (await review!.readApi("state")).state as {
    files: Array<{ key: string; path: string }>;
  };
  const target = state.files.find((file) => file.path === "src/gen/module-07.ts")!;
  // Large notes until one is refused, then halve, until even a one-byte note does not fit.
  let size = 250 * 1024;
  let added = 0;
  while (size > 0) {
    const response = await review!.postAction({
      type: "notes/add-user",
      fileKey: target.key,
      hunkIndex: 0,
      body: "b".repeat(size),
    });
    const outcome = (await response.json()) as { ok: boolean; code?: string };
    if (outcome.ok) {
      added += 1;
    } else {
      expect(outcome.code).toBe("too-many-notes");
      size = Math.floor(size / 2);
    }
  }
  expect(added).toBeGreaterThan(8);
  // Still registered: the agent surface answers for the session.
  expect(await listTestNotes()).toContain("src/gen/module-07.ts");

  await page.keyboard.press("c");
  await page.locator(".note-composer textarea").fill("One too many.");
  await page.locator(".note-composer textarea").press("Control+Enter");
  await expect(page.locator(".note-composer [role=alert]")).toContainText(
    "as many notes as Hunk can store",
  );
  // The draft keeps its text after the refusal.
  await expect(page.locator(".note-composer textarea")).toHaveValue("One too many.");
});

test("has no serious accessibility violations with a composer open", async ({ page }) => {
  await openTestReview(page);
  await page.keyboard.press("c");
  await expect(page.locator(".note-composer")).toBeVisible();
  const results = await new AxeBuilder({ page })
    .exclude("diffs-container")
    .exclude("file-tree-container")
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => violation.id);
  expect(serious).toEqual([]);
});

/**
 * Drives the review page against a real headless session through the agent's own commands.
 *
 * Covers what the shared-state route brings the page: sidecar and live notes (added, batched,
 * replied to, removed, cleared) appearing and disappearing live, a reviewer reply threaded
 * under an agent note, STML markup, agent highlights, `hunk session navigate` moving the page,
 * annotated navigation, a custom theme from config with the session-theme override, the page's
 * position reported to `hunk session context`, and a reload keeping notes and position.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  startTestWebReview,
  waitForTestCondition,
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

/** Agent context for the rich scenario's first file: one plain note and one STML note. */
const MAIN_CONTEXT: TestWebReviewOptions["context"] = {
  "src/app/main.ts": {
    summary: "Raises the threshold and adds a formatter.",
    annotations: [
      {
        newRange: [13, 13],
        summary: "Threshold raised from 5 to 10.",
        rationale: "Matches the new defaults.",
        author: "sonnet",
      },
      {
        newRange: [45, 47],
        summary: "describe() is new.",
        markup:
          '<box border title="Check"><text><badge color="success">OK</badge> <b>describe</b> is new</text></box>',
      },
    ],
  },
};

/** Start the rich review with agent notes showing, and open the page on it. */
async function openTestReview(page: Page, options: TestWebReviewOptions = {}) {
  review = await startTestWebReview("--rich", {
    ...options,
    args: ["--agent-notes", ...(options.args ?? [])],
  });
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** Add one live comment and return its id. */
async function addTestComment(file: string, line: number, summary: string, extra: string[] = []) {
  const output = await review!.hunk([
    "session",
    "comment",
    "add",
    review!.sessionId,
    "--file",
    file,
    "--new-line",
    String(line),
    "--summary",
    summary,
    "--json",
    ...extra,
  ]);
  return (JSON.parse(output) as { result: { commentId: string } }).result.commentId;
}

/** The note card with one summary. */
function noteCard(page: Page, summary: string) {
  return page.locator(".note-card", { hasText: summary });
}

test("renders sidecar notes, STML markup, and the session title", async ({ page }) => {
  await openTestReview(page, { args: ["--experimental"], context: MAIN_CONTEXT });

  const plain = noteCard(page, "Threshold raised from 5 to 10.");
  await expect(plain).toBeVisible();
  await expect(plain.locator(".note-author")).toHaveText("sonnet");
  await expect(plain.locator(".note-range")).toHaveText("R13");
  await expect(plain.locator(".note-rationale")).toHaveText("Matches the new defaults.");
  await expect(page.locator(".note-card .stml-badge")).toHaveText("OK");
  await expect(page.locator(".note-card .stml-box-title")).toHaveText("Check");
  await expect(page.locator(".review-title")).toHaveText("review-repo staged changes");

  await page.getByRole("radio", { name: "Flat" }).click();
  await expect(
    page.locator(".flat-file", { hasText: "main.ts" }).locator("[data-badge]").first(),
  ).toHaveText("*2");
});

test("shows live comments as an agent adds, replies to, removes, and clears them", async ({
  page,
}) => {
  await openTestReview(page);

  const first = await addTestComment("src/app/main.ts", 13, "First live note", [
    "--author",
    "opus",
  ]);
  await expect(noteCard(page, "First live note")).toBeVisible();
  await expect(noteCard(page, "First live note").locator(".note-author")).toHaveText(/^opus · /);

  await review!.hunk([
    "session",
    "comment",
    "add",
    review!.sessionId,
    "--reply-to",
    first,
    "--summary",
    "Agent reply",
  ]);
  await expect(noteCard(page, "Agent reply")).toHaveAttribute("data-depth", "1");

  // A reply written through the review link (as another browser tab would) threads under the
  // agent's note and is labelled by where it came from.
  const state = (await review!.readApi("state")).state as {
    notes: { note: { id: string; fileKey: string; anchor: { ownerHunkIndex?: number } } }[];
  };
  const parent = state.notes.find((entry) => entry.note.id === first)!.note;
  const response = await review!.postAction({
    type: "notes/add-user",
    fileKey: parent.fileKey,
    hunkIndex: parent.anchor.ownerHunkIndex ?? 0,
    parentId: first,
    body: "Reviewer reply",
  });
  expect(response.ok).toBe(true);
  const reply = noteCard(page, "Reviewer reply");
  await expect(reply).toHaveAttribute("data-source", "user");
  await expect(reply.locator(".note-author")).toHaveText(/^Browser note/);

  await review!.hunk(
    ["session", "comment", "apply", review!.sessionId, "--stdin"],
    JSON.stringify({
      comments: [
        { filePath: "src/gen/module-03.ts", newLine: 2, summary: "Batch one" },
        { filePath: "src/gen/module-04.ts", newLine: 2, summary: "Batch two" },
      ],
    }),
  );
  await page.getByRole("radio", { name: "Flat" }).click();
  await expect(page.locator(".flat-file", { hasText: "module-03.ts" })).toContainText("*1");
  await page.locator(".flat-file", { hasText: "module-04.ts" }).click();
  await expect(noteCard(page, "Batch two")).toBeVisible();

  // A note with replies stays; a leaf note can be removed.
  await page.locator(".flat-file", { hasText: "main.ts" }).click();
  const removable = await addTestComment("src/app/main.ts", 46, "Removable note");
  await expect(noteCard(page, "Removable note")).toBeVisible();
  await review!.hunk(["session", "comment", "rm", review!.sessionId, removable]);
  await expect(noteCard(page, "Removable note")).toHaveCount(0);
  await expect(noteCard(page, "First live note")).toBeVisible();

  // Agent notes with a reviewer's reply cannot be cleared alone; `--all` clears both.
  await review!.hunk(["session", "comment", "clear", review!.sessionId, "--all", "--yes"]);
  await expect(page.locator(".note-card")).toHaveCount(0);
  await expect(page.locator(".flat-file", { hasText: "module-04.ts" })).not.toContainText("*");
});

test("follows hunk session navigate and highlights", async ({ page }) => {
  await openTestReview(page);

  await review!.hunk([
    "session",
    "navigate",
    review!.sessionId,
    "--file",
    "src/gen/module-30.ts",
    "--hunk",
    "1",
  ]);
  await expect(page.locator("section[data-selected] .file-path")).toHaveText(
    "src/gen/module-30.ts",
  );
  await expect(page.getByTestId("selected-hunk")).toBeInViewport();

  await review!.hunk([
    "session",
    "highlight",
    "add",
    review!.sessionId,
    "--file",
    "src/gen/module-30.ts",
    "--new-line",
    "2",
    "--start",
    "7",
    "--end",
    "12",
    "--tone",
    "warning",
  ]);
  const mark = page.locator('.agent-highlight[data-tone="warning"]');
  await expect(mark).toHaveCount(1);
  await expect(mark).toBeInViewport();
});

test("walks annotated hunks with the keyboard", async ({ page }) => {
  await openTestReview(page);
  await addTestComment("src/gen/module-10.ts", 2, "Tenth module note");
  await addTestComment("src/gen/module-20.ts", 2, "Twentieth module note");
  await page.getByRole("radio", { name: "Flat" }).click();
  await expect(page.locator(".flat-file", { hasText: "module-20.ts" })).toContainText("*1");

  await page.keyboard.press("}");
  await expect(page.locator("section[data-selected] .file-path")).toHaveText(
    "src/gen/module-10.ts",
  );
  await expect(noteCard(page, "Tenth module note")).toBeInViewport();
  await page.keyboard.press("}");
  await expect(page.locator("section[data-selected] .file-path")).toHaveText(
    "src/gen/module-20.ts",
  );
  await page.keyboard.press("{");
  await expect(page.locator("section[data-selected] .file-path")).toHaveText(
    "src/gen/module-10.ts",
  );
});

test("starts from a custom session theme and lets this browser override it", async ({ page }) => {
  await openTestReview(page, {
    config: [
      'theme = "ocean"',
      "",
      "[themes.ocean]",
      'base = "nord"',
      'label = "Ocean"',
      'accent = "#7fd1ff"',
      "",
    ].join("\n"),
  });
  const accent = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--hunk-accent").trim(),
    );
  await expect.poll(accent).toBe("#7fd1ff");
  await expect(page.getByTestId("theme-picker")).toHaveAttribute("aria-label", "Theme: Ocean");

  await page.getByTestId("theme-picker").click();
  await page.locator('[role="option"][data-theme-id="dracula"]').click();
  await expect.poll(accent).not.toBe("#7fd1ff");
  await page.reload();
  await expect(page.getByTestId("theme-picker")).toHaveAttribute("aria-label", "Theme: dracula");

  await page.getByTestId("theme-picker").click();
  await page.getByRole("option", { name: /Use session theme/ }).click();
  await expect.poll(accent).toBe("#7fd1ff");
});

test("reports where the reader is to hunk session context", async ({ page }) => {
  await openTestReview(page);
  await page.locator(".review-stream").hover();
  await page.mouse.wheel(0, 2_400);
  const selected = await waitForTestCondition("the selection to follow the scroll", async () => {
    const path = await page.locator("section[data-selected] .file-path").textContent();
    return path?.startsWith("src/gen/") ? path : undefined;
  });
  await waitForTestCondition("the session to report the page's position", async () => {
    const context = JSON.parse(
      await review!.hunk(["session", "context", review!.sessionId, "--json"]),
    ) as { context?: { selectedFile?: { path?: string } } };
    return JSON.stringify(context).includes(selected) ? true : undefined;
  });
});

test("keeps notes and the reader's place across a reload", async ({ page }) => {
  await openTestReview(page, { context: MAIN_CONTEXT });
  await addTestComment("src/gen/module-20.ts", 2, "Survives the reload");
  await page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    const section = Array.from(
      document.querySelectorAll<HTMLElement>("section[data-file-key]"),
    ).find((candidate) => candidate.textContent?.includes("src/gen/module-20.ts"))!;
    stream.scrollTop = section.offsetTop;
  });
  await expect(noteCard(page, "Survives the reload")).toBeVisible({ timeout: 15_000 });
  const generation = await page.locator(".review-app").getAttribute("data-generation");

  await review!.reload();
  await expect(page.locator(".review-app")).not.toHaveAttribute(
    "data-generation",
    generation ?? "",
    {
      timeout: 30_000,
    },
  );
  await expect(noteCard(page, "Survives the reload")).toBeInViewport({ timeout: 15_000 });
  await page.getByRole("radio", { name: "Flat" }).click();
  await page.locator(".flat-file", { hasText: "main.ts" }).click();
  await expect(noteCard(page, "Threshold raised from 5 to 10.")).toBeVisible({
    timeout: 15_000,
  });
});

test("has no serious accessibility violations with notes showing", async ({ page }) => {
  await openTestReview(page, { args: ["--experimental"], context: MAIN_CONTEXT });
  await addTestComment("src/app/main.ts", 46, "A live note");
  await expect(noteCard(page, "A live note")).toBeVisible();
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

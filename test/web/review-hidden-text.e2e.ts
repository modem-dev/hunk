/**
 * Checks that the review page shows hidden-character spoofing instead of being fooled by it.
 *
 * The fixture (`fixtures/hidden-text-review.ts`) stages a "Trojan Source" file (CVE-2021-42574)
 * whose bidi overrides make `if (isAdmin)` read as part of a comment, a file named with a
 * right-to-left override to fake its extension, zero-width characters in a path and an
 * identifier, an agent note carrying controls of its own, and legitimate Hebrew and Arabic
 * text. The page must draw every control as a code-point marker in the text's real logical
 * order — in code (both layouts), headers, both sidebar modes, go-to-file, notes, and the
 * Notes tab — warn on the files that hold them, leave the right-to-left file untouched, and
 * keep the code's text content byte-for-byte so copying stays faithful.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  HIDDEN_TEXT_NOTE_SUMMARY,
  HIDDEN_TEXT_PATHS,
  RTL_LINE,
  TROJAN_SOURCE_LINE,
  ZERO_WIDTH_LINE,
} from "./fixtures/hidden-text-review";
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

/** Start the hidden-text review and open it in one layout and sidebar mode. */
async function openTestHiddenTextReview(
  page: Page,
  view: { layout: "unified" | "split"; sidebarMode: "flat" | "tree" },
) {
  review = await startTestWebReview("--hidden-text", { args: ["--agent-notes"] });
  problems = await watchTestPageProblems(page);
  await page.addInitScript(
    (stored) => window.localStorage.setItem("hunk.review.view", stored),
    JSON.stringify(view),
  );
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** The stream section of one file, found by its accessible name (hidden characters spelled out). */
function testFileSection(page: Page, path: string) {
  return page.locator(`section.file-section[aria-label="${spelledTestPath(path)}"]`);
}

/** A path with its hidden characters spelled `<U+XXXX>`, as plain-text sinks show it. */
function spelledTestPath(path: string) {
  return path.replace(
    /[\u200B\u202E]/gu,
    (character) => `<U+${character.codePointAt(0)!.toString(16).toUpperCase()}>`,
  );
}

/** The new side's drawn code line `line` of one file section, in either layout. */
function testCodeLine(section: Locator, line: number) {
  return section
    .locator(`[data-line="${line}"][data-line-type]:not([data-line-type*="deletion"])`)
    .first();
}

/** The labels of the markers inside one element, in DOM order. */
async function markerLabels(element: Locator) {
  return element
    .locator(".hidden-char")
    .evaluateAll((markers) => markers.map((marker) => marker.getAttribute("data-label")));
}

/**
 * The left edge of each fragment as drawn inside `element`, found through a DOM range over
 * its text. Visual order equals logical order exactly when these increase.
 */
async function drawnLeftEdges(element: Locator, fragments: readonly string[]) {
  return element.evaluate((root, wanted) => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    return wanted.map((fragment) => {
      for (const node of nodes) {
        const offset = node.data.indexOf(fragment);
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + fragment.length);
        return range.getBoundingClientRect().left;
      }
      throw new Error(`"${fragment}" is not drawn here.`);
    });
  }, fragments);
}

/** Expect numbers to increase strictly. */
function expectIncreasing(values: readonly number[]) {
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index]!).toBeGreaterThan(values[index - 1]!);
  }
}

for (const layout of ["unified", "split"] as const) {
  test(`draws a Trojan Source line in its logical order in ${layout} view`, async ({ page }) => {
    await openTestHiddenTextReview(page, { layout, sidebarMode: "flat" });

    const bidi = testFileSection(page, HIDDEN_TEXT_PATHS.bidi);
    const line = testCodeLine(bidi, 2);
    await expect(line.locator(".hidden-char")).toHaveCount(4);
    expect(await markerLabels(line)).toEqual(["U+202E", "U+2066", "U+2069", "U+2066"]);
    // `if (isAdmin)` sits between the comment opener and its words, where the compiler sees it.
    expectIncreasing(await drawnLeftEdges(line, ["/*", "if (isAdmin)", "begin admins only"]));
    // The markers' labels are generated content, so the text (and a copy of it) is the file's.
    expect(await line.textContent()).toBe(TROJAN_SOURCE_LINE);

    const zeroWidth = testCodeLine(testFileSection(page, HIDDEN_TEXT_PATHS.zeroWidth), 1);
    expect(await markerLabels(zeroWidth)).toEqual(["U+200B"]);
    expect(await zeroWidth.textContent()).toBe(ZERO_WIDTH_LINE);

    // Legitimate right-to-left text has no controls, so it is drawn exactly as before.
    const rtl = testFileSection(page, HIDDEN_TEXT_PATHS.rtl);
    await expect(rtl.locator(".hidden-char")).toHaveCount(0);
    expect(await testCodeLine(rtl, 1).textContent()).toBe(RTL_LINE);
  });
}

test("reveals a spoofed file name and warns on files with hidden characters", async ({ page }) => {
  await openTestHiddenTextReview(page, { layout: "unified", sidebarMode: "flat" });

  const spoofed = testFileSection(page, HIDDEN_TEXT_PATHS.spoofed);
  const name = spoofed.locator(".file-path-base");
  expect(await markerLabels(name)).toEqual(["U+202E"]);
  expectIncreasing(await drawnLeftEdges(name, ["file", "txt.exe"]));
  await expect(spoofed.locator(".file-name")).toHaveAttribute(
    "title",
    spelledTestPath(HIDDEN_TEXT_PATHS.spoofed),
  );

  await expect(spoofed.getByTestId("hidden-text-chip")).toContainText("bidirectional Unicode");
  await expect(
    testFileSection(page, HIDDEN_TEXT_PATHS.bidi).getByTestId("hidden-text-chip"),
  ).toContainText("bidirectional Unicode");
  await expect(
    testFileSection(page, HIDDEN_TEXT_PATHS.zeroWidth).getByTestId("hidden-text-chip"),
  ).toContainText("hidden Unicode");
  await expect(
    testFileSection(page, HIDDEN_TEXT_PATHS.rtl).getByTestId("hidden-text-chip"),
  ).toHaveCount(0);

  const results = await new AxeBuilder({ page })
    .include('[data-testid="hidden-text-chip"]')
    .include(".file-header .hidden-char")
    .analyze();
  expect(results.passes.length).toBeGreaterThan(0);
  expect(
    results.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);

  // The flat sidebar draws the same marker in the name.
  const row = page.locator(".flat-row").filter({ hasText: "txt.exe" });
  expect(await markerLabels(row.locator(".flat-name"))).toEqual(["U+202E"]);
  expectIncreasing(await drawnLeftEdges(row.locator(".flat-name"), ["file", "txt.exe"]));

  // Go to file lists the path with its marker.
  await page.locator(".review-stream").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+p");
  const option = page.getByTestId("go-to-file").getByRole("option").filter({ hasText: "txt.exe" });
  expect(await markerLabels(option)).toEqual(["U+202E"]);
});

test("spells hidden characters out in the tree sidebar", async ({ page }) => {
  await openTestHiddenTextReview(page, { layout: "unified", sidebarMode: "tree" });

  const tree = page.locator("file-tree-container");
  await expect(tree.getByRole("treeitem", { name: "file<U+202E>txt.exe" })).toHaveCount(1);
  await expect(tree.getByRole("treeitem", { name: "zero<U+200B>width.js" })).toHaveCount(1);
  await expect(tree.getByRole("treeitem", { name: "greeting.js" })).toHaveCount(1);
  await expect(tree.getByRole("treeitem", { name: /fileexe|file\.txtexe/ })).toHaveCount(0);
});

test("reveals hidden characters in agent notes and the Notes tab", async ({ page }) => {
  await openTestHiddenTextReview(page, { layout: "unified", sidebarMode: "flat" });

  const card = page.locator(".note-card").first();
  expect(await markerLabels(card.locator(".note-author"))).toEqual(["U+200B"]);
  const summary = card.locator(".note-summary");
  expect(await markerLabels(summary)).toEqual(["U+202E"]);
  expect(await summary.textContent()).toBe(HIDDEN_TEXT_NOTE_SUMMARY);
  expectIncreasing(await drawnLeftEdges(summary, ["admin", "check"]));

  await page.getByTestId("toggle-side-panel").click();
  await page.getByRole("tab", { name: "Notes" }).click();
  const row = page.getByTestId("notes-row").first();
  expect(await markerLabels(row.locator(".notes-summary"))).toEqual(["U+202E"]);
  expect(await markerLabels(row.locator(".notes-author"))).toEqual(["U+200B"]);
});

/**
 * Drives the review page from the keyboard against a rich live review.
 *
 * Covers the command layer end to end: hunk and file navigation through the shared planner
 * with reveals that land under the sticky file header, navigation that continues from where
 * the reader scrolled to, rapid key sequences that land where slow ones do, the view keys, the
 * gap toggle, the theme menu, mouse parity for hunk selection, and the keys the page must
 * leave alone — anything typed into a field and every browser or OS chord.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  openTestThemeMenu,
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
  await page.addInitScript(() =>
    window.localStorage.setItem("hunk.review.view", '{"layout":"split","sidebarMode":"flat"}'),
  );
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

/** Open the review, wait until every file has loaded, and put focus on the page body. */
async function openTestReview(page: Page) {
  await page.goto(review!.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("selected-hunk")).toBeVisible({ timeout: 15_000 });
}

/** The selected file's path, as its stream header shows it. */
function selectedPath(page: Page) {
  return page.locator("section[data-selected] .file-path").textContent();
}

/** Where the selected-hunk rail and the stream's sticky header sit in the viewport. */
function railPosition(page: Page) {
  return page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    const rail = document.querySelector<HTMLElement>('[data-testid="selected-hunk"]');
    const header = document.querySelector<HTMLElement>("section[data-selected] .file-header")!;
    if (!rail) return undefined;
    const streamTop = stream.getBoundingClientRect().top;
    return {
      railTop: rail.getBoundingClientRect().top - streamTop,
      headerBottom: header.getBoundingClientRect().bottom - streamTop,
      hunk: Number(rail.dataset.hunkIndex),
    };
  });
}

/** Wait until the rail shows one hunk, revealed just under the sticky header. */
async function expectHunkRevealed(page: Page, hunk: number) {
  await waitForTestCondition(
    `hunk ${hunk} to be revealed under the header`,
    async () => {
      const position = await railPosition(page);
      if (!position || position.hunk !== hunk) return undefined;
      const gap = position.railTop - position.headerBottom;
      return gap >= 0 && gap <= 20 ? true : undefined;
    },
    10_000,
  );
}

/** Wait until the selected file's header is at the top of the stream. */
async function expectFileTopRevealed(page: Page, path: string) {
  await expect.poll(() => selectedPath(page)).toBe(path);
  await waitForTestCondition(`${path} to be at the top`, () =>
    page.evaluate(() => {
      const stream = document.querySelector<HTMLElement>(".review-stream")!;
      const section = document.querySelector<HTMLElement>("section[data-selected]")!;
      return Math.abs(section.offsetTop - stream.scrollTop) <= 1 ? true : undefined;
    }),
  );
}

test("navigates hunks and files, revealing each under the sticky header", async ({ page }) => {
  await openTestReview(page);
  expect(await selectedPath(page)).toBe("src/app/main.ts");

  await page.keyboard.press("]");
  await expectHunkRevealed(page, 1);
  expect(await selectedPath(page)).toBe("src/app/main.ts");

  // Crossing into the next file lands on its first hunk.
  await page.keyboard.press("]");
  await expect.poll(() => selectedPath(page)).toBe("src/app/renamed-old.ts -> renamed-new.ts");
  await expect(page.getByTestId("selected-hunk")).toHaveAttribute("data-hunk-index", "0");

  await page.keyboard.press("[");
  await expect.poll(() => selectedPath(page)).toBe("src/app/main.ts");
  await expectHunkRevealed(page, 1);

  await page.keyboard.press(".");
  await expectFileTopRevealed(page, "src/app/renamed-old.ts -> renamed-new.ts");
  await page.keyboard.press(",");
  await expectFileTopRevealed(page, "src/app/main.ts");

  // Far down the review, into files that have not drawn yet.
  for (let step = 0; step < 30; step += 1) await page.keyboard.press(".");
  const far = await selectedPath(page);
  expect(far).toMatch(/^src\/gen\/module-\d\d\.ts$/);
  await expectFileTopRevealed(page, far!);
  await page.keyboard.press("]");
  await expect.poll(() => selectedPath(page)).not.toBe(far);
  await expect(page.getByTestId("selected-hunk")).toBeInViewport();
});

test("continues navigation from where the reader scrolled to", async ({ page }) => {
  await openTestReview(page);

  // Scroll by hand to the middle of the generated modules and let the viewport settle.
  await page.locator(".review-stream").hover();
  await page.mouse.wheel(0, 2_400);
  const centered = await waitForTestCondition("the selection to follow the scroll", async () => {
    const path = await selectedPath(page);
    return path?.startsWith("src/gen/") ? path : undefined;
  });
  const middle = await page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    const center = stream.scrollTop + stream.clientHeight / 2;
    const section = Array.from(
      document.querySelectorAll<HTMLElement>("section[data-file-key]"),
    ).find((candidate) => candidate.offsetTop + candidate.offsetHeight > center)!;
    return section.querySelector(".file-path")!.textContent;
  });
  expect(centered).toBe(middle);
  await expect(page.locator(".flat-file[data-selected]")).toContainText(middle!.split("/").pop()!);

  const index = Number(/module-(\d\d)/.exec(middle!)![1]);
  await page.keyboard.press("]");
  await expect
    .poll(() => selectedPath(page))
    .toBe(`src/gen/module-${String(index + 1).padStart(2, "0")}.ts`);
});

/** The selection as the page shows it: the selected file's path and the rail's hunk. */
function selectionAt(page: Page) {
  return page.evaluate(() => {
    const path = document.querySelector("section[data-selected] .file-path")?.textContent;
    const rail = document.querySelector<HTMLElement>('[data-testid="selected-hunk"]');
    return `${path ?? "none"} hunk ${rail?.dataset.hunkIndex ?? "none"}`;
  });
}

/** Wait until the selection has held still for a moment, and return it. */
async function settledSelection(page: Page) {
  let last = await selectionAt(page);
  let since = Date.now();
  return waitForTestCondition("the selection to settle", async () => {
    const now = await selectionAt(page);
    if (now !== last) {
      last = now;
      since = Date.now();
      return undefined;
    }
    return Date.now() - since >= 800 ? now : undefined;
  });
}

/**
 * Press `keys` with `gapMs` between them, starting from the top of the review as `g` leaves
 * it, and return where they start and where they land.
 */
async function pressFromTop(page: Page, keys: readonly string[], gapMs: number) {
  // Leave the top first, so `g` always scrolls and the start is the hunk it settles on.
  await page.keyboard.press("Shift+G");
  await settledSelection(page);
  await page.keyboard.press("g");
  const start = await settledSelection(page);
  for (const key of keys) {
    await page.keyboard.press(key);
    if (gapMs > 0) await page.waitForTimeout(gapMs);
  }
  return { start, end: await settledSelection(page) };
}

// Intent: each key applies to the result of the one before it, as in the terminal, however
// fast the keys come. A scroll key (`g`, Space) moves the selection to the hunk it brings to
// the middle only once the viewport settles; a key pressed sooner must start from there, not
// from where the selection was. A jump's own reveal, still settling as the files around it
// draw, must not hand the selection to the viewport either.
test("lands rapid key sequences where the same keys pressed slowly land", async ({ page }) => {
  // Every sequence runs twice and waits for each run to settle.
  test.slow();
  await openTestReview(page);
  const sequences: readonly (readonly string[])[] = [
    ["]", "]", "]", "]", "]"],
    // `g` then `.` well within 50 ms: `.` moves from the top, not from the old position.
    [".", ".", ".", ".", ".", ".", "g", "."],
    ["]", "]", "]", "]", "]", "g", "]", "]", "]", "]", "]"],
    ["Space", "]"],
    ["Space", "Space", "["],
    [".", ".", ".", ".", ".", ".", ".", ".", ".", ".", "]"],
    ["Shift+G", "[", "["],
  ];
  for (const keys of sequences) {
    const slow = await pressFromTop(page, keys, 400);
    const fast = await pressFromTop(page, keys, 0);
    expect(fast.start).toBe(slow.start);
    expect.soft(fast.end, `${keys.join(" ")} pressed rapidly`).toBe(slow.end);
  }
});

test("scrolls with the paging keys and jumps to either end", async ({ page }) => {
  await openTestReview(page);
  const scrollTop = () =>
    page.evaluate(() => document.querySelector<HTMLElement>(".review-stream")!.scrollTop);

  await page.keyboard.press("j");
  await expect.poll(scrollTop).toBe(20);
  await page.keyboard.press("k");
  await expect.poll(scrollTop).toBe(0);
  await page.keyboard.press("Space");
  await expect.poll(scrollTop).toBeGreaterThan(600);
  await page.keyboard.press("b");
  await expect.poll(scrollTop).toBe(0);
  await page.keyboard.press("d");
  await expect.poll(scrollTop).toBeGreaterThan(300);
  await page.keyboard.press("u");
  await expect.poll(scrollTop).toBe(0);

  await page.keyboard.press("Shift+G");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stream = document.querySelector<HTMLElement>(".review-stream")!;
        return stream.scrollHeight - stream.clientHeight - stream.scrollTop;
      }),
    )
    .toBeLessThanOrEqual(1);
  await page.keyboard.press("g");
  await expect.poll(scrollTop).toBe(0);
});

// Intent: a jump to the end lands on the height laid out at that moment; files that draw
// taller afterwards must not leave the reader short of the end, and the reader's own scroll
// must still win.
test("holds the end while files below finish drawing, until the reader scrolls", async ({
  page,
}) => {
  await openTestReview(page);
  const distanceFromEnd = () =>
    page.evaluate(() => {
      const stream = document.querySelector<HTMLElement>(".review-stream")!;
      return stream.scrollHeight - stream.clientHeight - stream.scrollTop;
    });

  await page.keyboard.press("Shift+G");
  // A file at the end grows after the jump, as a late first draw does.
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const sections = document.querySelectorAll<HTMLElement>("section[data-file-key]");
    const grown = document.createElement("div");
    grown.style.height = "400px";
    sections[sections.length - 1]!.append(grown);
  });
  await page.waitForTimeout(600);
  expect(await distanceFromEnd()).toBeLessThanOrEqual(1);

  await page.keyboard.press("k");
  await page.waitForTimeout(600);
  expect(await distanceFromEnd()).toBeGreaterThanOrEqual(19);
});

test("switches layout and view options from the keyboard", async ({ page }) => {
  await openTestReview(page);
  const app = page.locator(".review-app");

  await page.keyboard.press("1");
  await expect(app).toHaveAttribute("data-layout", "unified");
  await expect(page.getByTestId("layout-unified")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("2");
  await expect(app).toHaveAttribute("data-layout", "split");
  await page.keyboard.press("0");
  await expect(page.getByTestId("layout-auto")).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("s");
  await expect(page.locator("nav.sidebar")).toHaveCount(0);
  await page.keyboard.press("s");
  await expect(page.locator("nav.sidebar")).toHaveCount(1);

  // The View menu's rows track the shortcuts while it is closed.
  await page.keyboard.press("w");
  await expect(page.getByTestId("toggle-wrap")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("l");
  await expect(page.getByTestId("toggle-line-numbers")).toHaveAttribute("aria-checked", "false");

  // The theme menu opens from `t`, moves with the arrow keys, and chooses with Enter.
  const before = await page.getByTestId("theme-picker").getAttribute("data-theme-id");
  await page.keyboard.press("t");
  const menu = page.getByRole("listbox", { name: "Themes" });
  await expect(menu).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("view-menu-button")).toBeFocused();
  await expect(page.getByTestId("theme-picker")).not.toHaveAttribute("data-theme-id", before ?? "");
  await page.keyboard.press("t");
  await expect(menu).toBeVisible();
  // A letter no theme starts with stays in the open menu instead of reaching page shortcuts.
  const scrollTop = () =>
    page.evaluate(() => document.querySelector<HTMLElement>(".review-stream")!.scrollTop);
  const scrolledBefore = await scrollTop();
  await page.keyboard.press("j");
  await page.waitForTimeout(200);
  expect(await scrollTop()).toBe(scrolledBefore);
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("toggles the selected hunk's gap and collapses it in place", async ({ page }) => {
  await openTestReview(page);
  const main = page.locator("section[data-file-key]").first();

  await page.keyboard.press("z");
  const collapse = main.locator('.gap-collapse[data-gap-id="before:0"]');
  await expect(collapse).toHaveText("Hide 9 unchanged lines", { timeout: 15_000 });
  await collapse.click();
  await expect(collapse).toHaveCount(0);
  await expect(main.locator('.gap-separator[data-gap-id="before:0"]').first()).toHaveText(
    "9 unchanged lines",
  );

  // `z` again expands, and `z` once more folds it back.
  await page.keyboard.press("z");
  await expect(collapse).toBeVisible();
  await page.keyboard.press("z");
  await expect(collapse).toHaveCount(0);
});

test("selects a hunk by clicking its rows", async ({ page }) => {
  await openTestReview(page);
  const main = page.locator("section[data-file-key]").first();
  await expect(page.getByTestId("selected-hunk")).toHaveAttribute("data-hunk-index", "0");

  await main.locator("diffs-container").getByText("describe").first().click();
  await expect(page.getByTestId("selected-hunk")).toHaveAttribute("data-hunk-index", "1");
});

test("leaves typing and browser shortcuts alone", async ({ page }) => {
  await openTestReview(page);

  // A key typed into a field is text, not a command.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "probe-input";
    input.setAttribute("aria-label", "Probe");
    document.body.appendChild(input);
  });
  await page.locator("#probe-input").focus();
  await page.keyboard.type("]].1s");
  await expect(page.locator("#probe-input")).toHaveValue("]].1s");
  await expect(page.getByTestId("selected-hunk")).toHaveAttribute("data-hunk-index", "0");
  await expect(page.locator("nav.sidebar")).toHaveCount(1);
  await expect(page.locator(".review-app")).toHaveAttribute("data-layout", "split");
  await page.locator("#probe-input").blur();

  // Browser and OS chords pass through untouched, including ones the catalog binds (Ctrl+D
  // and Ctrl+U page in the terminal) and function keys.
  const prevented = await page.evaluate(() => {
    const chords: KeyboardEventInit[] = [
      { key: "f", ctrlKey: true },
      { key: "f", metaKey: true },
      { key: "c", ctrlKey: true },
      { key: "d", ctrlKey: true },
      { key: "u", ctrlKey: true },
      { key: "ArrowLeft", altKey: true },
      { key: "[", metaKey: true },
      { key: "]", metaKey: true },
      { key: "=", ctrlKey: true },
      { key: "1", ctrlKey: true },
      { key: "Tab" },
      { key: "Tab", shiftKey: true },
      { key: "F5" },
      { key: "F12" },
    ];
    const stream = document.querySelector<HTMLElement>(".review-stream")!;
    return chords.flatMap((init) => {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented || stream.scrollTop !== 0 ? [JSON.stringify(init)] : [];
    });
  });
  expect(prevented).toEqual([]);
  await expect(page.getByTestId("selected-hunk")).toHaveAttribute("data-hunk-index", "0");

  // Space on a focused menu row presses it; it does not page the review.
  await openTestViewMenu(page);
  await page.getByTestId("toggle-wrap").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("toggle-wrap")).toHaveAttribute("aria-checked", "true");
  expect(
    await page.evaluate(() => document.querySelector<HTMLElement>(".review-stream")!.scrollTop),
  ).toBe(0);
});

test("keeps focus order sane and the open theme menu accessible", async ({ page }) => {
  await openTestReview(page);

  // Toolbar first, then the sidebar, then the stream.
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("toggle-sidebar")).toBeFocused();
  const order: string[] = [];
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(() => {
        const active = document.activeElement as HTMLElement;
        if (active.closest(".toolbar")) return "toolbar";
        if (active.closest(".sidebar")) return "sidebar";
        if (active.closest(".review-stream")) return "stream";
        return active.tagName;
      }),
    );
  }
  const firstSidebar = order.indexOf("sidebar");
  const firstStream = order.indexOf("stream");
  expect(firstSidebar).toBeGreaterThan(0);
  expect(order.slice(0, firstSidebar).every((region) => region === "toolbar")).toBe(true);
  expect(firstStream === -1 || firstStream > firstSidebar).toBe(true);

  await openTestThemeMenu(page);
  const results = await new AxeBuilder({ page })
    .exclude("diffs-container")
    .exclude("file-tree-container")
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => violation.id);
  expect(serious).toEqual([]);
});

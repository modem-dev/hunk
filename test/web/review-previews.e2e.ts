/**
 * Drives the rich previews against a real session reviewing images and Markdown.
 *
 * Images: a changed PNG compares side by side, by swipe, and by onion skin with sizes and
 * dimensions; an added and a deleted image show their one side; bytes named like an image
 * that are not one keep the stream's "Binary file skipped"; a PNG declaring 30000 × 30000 is
 * refused before decoding; an SVG, text or binary, never becomes a blob or an `<img>`, and
 * every blob the page mints has a raster type. Markdown: the header toggle swaps
 * a file's diff for its rendered text, a deleted file renders its old text, and nothing in the
 * document runs. No CSP violation or console error, and axe stays green.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { startTestWebReview, watchTestPageProblems, type TestWebReview } from "./webTestHarness";

let review: TestWebReview | undefined;
let problems: string[] = [];

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  review = await startTestWebReview("--previews");
  problems = await watchTestPageProblems(page);
  await page.goto(review.url);
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("load-progress")).toHaveCount(0, { timeout: 30_000 });
});

test.afterEach(async () => {
  expect(problems).toEqual([]);
  await review?.stop();
  review = undefined;
});

/** The stream section for one path. */
function section(page: Page, path: string) {
  return page.locator(`section[aria-label="${path}"]`);
}

test("compares a changed image side by side, by swipe, and by onion skin", async ({ page }) => {
  const photo = section(page, "images/photo.png");
  const preview = photo.getByTestId("image-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator("figcaption").first()).toHaveText(/^Before · 48 × 32 · \d+ B$/);
  await expect(preview.locator("figcaption").nth(1)).toHaveText(/^After · 64 × 32 · \d+ B$/);
  const sources = await preview
    .locator("img")
    .evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
  expect(sources.every((source) => source.startsWith("blob:"))).toBe(true);
  await expect
    .poll(() =>
      preview
        .locator("img")
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);

  await preview.getByTestId("image-mode-swipe").click();
  await expect(preview).toHaveAttribute("data-mode", "swipe");
  await preview.getByTestId("image-slider").fill("25");
  await expect(preview.locator(".image-preview-over")).toHaveAttribute(
    "style",
    /inset\(0px 0px 0px 25%\)/,
  );

  await preview.getByTestId("image-mode-onion").click();
  await preview.getByTestId("image-slider").fill("40");
  await expect(preview.locator(".image-preview-over")).toHaveAttribute("style", /opacity: 0\.4/);
});

test("shows added and deleted images single-sided, and keeps the placeholder for non-images", async ({
  page,
}) => {
  await expect(section(page, "images/added.png").locator("figcaption")).toHaveText(
    /^Added · 24 × 24/,
  );
  await section(page, "images/removed.png").scrollIntoViewIfNeeded();
  await expect(section(page, "images/removed.png").locator("figcaption")).toHaveText(
    /^Deleted · 16 × 16/,
  );
  await section(page, "images/fake.png").scrollIntoViewIfNeeded();
  await expect(section(page, "images/fake.png").locator('[data-empty-reason="binary"]')).toHaveText(
    "Binary file skipped",
  );
  await expect(section(page, "images/fake.png").locator("img")).toHaveCount(0);
});

test("refuses an image whose header declares a size past the decode limit", async ({ page }) => {
  const huge = section(page, "images/huge.png");
  await huge.scrollIntoViewIfNeeded();
  await expect(huge.getByTestId("image-preview-too-large")).toHaveText(
    "Image too large to preview: 30000 × 30000",
  );
  await expect(huge.locator("img")).toHaveCount(0);
});

test("never turns an SVG into a blob or an image, text or binary", async ({ page }) => {
  // Record every blob the page mints, from the first script on, then load the page again.
  await page.addInitScript(() => {
    const types: string[] = [];
    (window as { __blobTypes?: string[] }).__blobTypes = types;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      types.push(object instanceof Blob ? object.type : "media-source");
      return create(object);
    };
  });
  await page.reload();
  await expect(page.locator('.toolbar [data-state="connected"]')).toBeVisible({ timeout: 30_000 });
  await expect(section(page, "images/photo.png").getByTestId("image-preview")).toBeVisible();

  // A text SVG keeps its ordinary text diff.
  const script = section(page, "images/script.svg");
  await script.scrollIntoViewIfNeeded();
  await expect(script.locator("diffs-container")).toHaveCount(1);
  await expect(script.locator("img")).toHaveCount(0);
  await expect(script.getByTestId("image-preview")).toHaveCount(0);

  // A binary SVG keeps the stream's placeholder.
  const packed = section(page, "images/packed.svg");
  await packed.scrollIntoViewIfNeeded();
  await expect(packed.locator('[data-empty-reason="binary"]')).toHaveText("Binary file skipped");
  await expect(packed.locator("img")).toHaveCount(0);

  const types = await page.evaluate(() => (window as { __blobTypes?: string[] }).__blobTypes);
  expect(types!.length).toBeGreaterThan(0);
  const raster = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/x-icon",
  ];
  expect(types!.filter((type) => !raster.includes(type))).toEqual([]);
  expect(
    await page.evaluate(() => (window as { __hunkSvgPwned?: boolean }).__hunkSvgPwned),
  ).toBeUndefined();
});

test("revokes image URLs when previews unmount", async ({ page }) => {
  await expect(section(page, "images/photo.png").getByTestId("image-preview")).toBeVisible();
  const url = await section(page, "images/photo.png").locator("img").first().getAttribute("src");
  await page.evaluate(() => {
    const revoked: string[] = [];
    (window as { __revoked?: string[] }).__revoked = revoked;
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (target: string) => {
      revoked.push(target);
      revoke(target);
    };
  });
  // Leaving the area unmounts the file; a revoked blob URL no longer resolves.
  const stream = page.locator(".review-stream");
  await stream.evaluate((element) => {
    const spacer = document.createElement("div");
    spacer.style.height = "20000px";
    element.append(spacer);
  });
  await stream.evaluate((element) => (element.scrollTop = element.scrollHeight));
  await expect(section(page, "images/photo.png").locator("img")).toHaveCount(0, {
    timeout: 10_000,
  });
  expect(await page.evaluate(() => (window as { __revoked?: string[] }).__revoked)).toContain(url);
});

test("toggles a Markdown file between its diff and its rendered text, inertly", async ({
  page,
}) => {
  const guide = section(page, "docs/guide.md");
  await guide.scrollIntoViewIfNeeded();
  const toggle = guide.getByTestId("markdown-toggle");
  await expect(toggle).toHaveText("Rendered");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const rendered = guide.getByTestId("markdown-preview");
  await expect(rendered.locator("h1")).toHaveText("Guide");
  await expect(rendered.locator("strong")).toHaveText("new");
  await expect(rendered.locator("table td").nth(1)).toHaveText("80");
  await expect(rendered.locator("pre code")).toHaveText("hunk diff --web");
  // Raw HTML is text, and only the web link is a link.
  await expect(rendered).toContainText("<script>window.__hunkPwned = true</script>");
  expect(
    await page.evaluate(() => (window as { __hunkPwned?: boolean }).__hunkPwned),
  ).toBeUndefined();
  const links = rendered.locator("a");
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAttribute("href", "https://example.com/docs");
  await expect(links).toHaveAttribute("rel", "noopener noreferrer");
  await expect(links).toHaveAttribute("target", "_blank");

  await toggle.click();
  await expect(guide.getByTestId("markdown-preview")).toHaveCount(0);
  await expect(guide.locator("diffs-container")).toHaveCount(1);
});

test("renders a deleted Markdown file from its old text", async ({ page }) => {
  const removed = section(page, "docs/removed.md");
  await removed.scrollIntoViewIfNeeded();
  await removed.getByTestId("markdown-toggle").click();
  const rendered = removed.getByTestId("markdown-preview");
  await expect(rendered).toHaveAttribute("data-side", "old");
  await expect(rendered.locator("h1")).toHaveText("Removed");
});

test("has no serious accessibility violations with previews showing", async ({ page }) => {
  await section(page, "docs/guide.md").getByTestId("markdown-toggle").click();
  await expect(section(page, "images/photo.png").getByTestId("image-preview")).toBeVisible();
  const results = await new AxeBuilder({ page })
    .exclude("diffs-container")
    .exclude("file-tree-container")
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`,
    );
  expect(serious).toEqual([]);
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { brandColors, brandDownloadPath, brandFormats, brandLogos } from "../src/data/brand";

/** Decodes an image in the page and returns its top-left RGBA pixel. */
async function readTestCornerPixel(page: Page, src: string): Promise<number[]> {
  return page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  }, src);
}

/** Converts a #rrggbb color to its RGB channels. */
function hexToTestRgb(hex: string): number[] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

test("brand page is discoverable and offers working logo downloads", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("link", { name: "Brand", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Made for review.Ready to share.",
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://hunk.dev/brand/",
  );

  for (const logo of brandLogos) {
    for (const color of brandColors) {
      for (const format of brandFormats) {
        const link = page.getByRole("link", {
          name: `Download ${logo.name.toLowerCase()} in ${color.name.toLowerCase()} as ${format.name}`,
          exact: true,
        });
        const path = brandDownloadPath(logo.id, color.id, format.id);
        await expect(link).toHaveAttribute("href", path);
        await expect(link).toHaveAttribute("download", "");
        const response = await page.request.get(path);
        expect(response.ok()).toBe(true);
        const body = await response.body();
        if (format.extension === "png") {
          expect(body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
          expect(body.readUInt32BE(16)).toBe(2048);
          // The padded corner shows the backdrop: clear for transparent PNGs, the paired color for solid ones.
          expect(await readTestCornerPixel(page, path)).toEqual(
            format.id === "solid-png" ? [...hexToTestRgb(color.background), 255] : [0, 0, 0, 0],
          );
        } else if (format.id === "pdf") {
          expect(body.subarray(0, 5).toString()).toBe("%PDF-");
          // SVG masks export as embedded bitmaps; logo PDFs must stay pure vector.
          expect(body.toString("latin1")).not.toContain("/Subtype /Image");
        } else {
          expect(body.toString()).toContain(color.value);
          expect(body.toString()).not.toContain("<mask");
        }
      }
    }
  }

  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: /Download all assets/ }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("hunk-brand.zip");
  const zip = await page.request.get("/brand/hunk-brand.zip");
  expect(zip.ok()).toBe(true);
  expect((await zip.body()).subarray(0, 4).toString("hex")).toBe("504b0304");
});

test("brand page stays accessible and fits narrow screens without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto("/brand/");
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      for (const image of await page.locator(".brand-preview img").all()) {
        expect(
          await image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
        ).toBe(true);
      }
    }
    await expect(page.getByRole("link", { name: /Download all assets/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("brand page has no serious accessibility violations in either theme", async ({ page }) => {
  await page.goto("/brand/");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(
      results.violations.filter(({ impact }) => impact === "critical" || impact === "serious"),
    ).toEqual([]);
  }
});

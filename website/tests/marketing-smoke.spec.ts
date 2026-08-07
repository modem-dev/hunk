import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("marketing page links into documentation and preserves core calls to action", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);
  await expect(
    page.getByRole("heading", { level: 1, name: /Terminal diffs for humans & agents/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }).getByText("Docs"),
  ).toHaveAttribute("href", "/docs/");
  await expect(page.getByRole("button", { name: "Copy: npm i -g hunkdiff" })).toBeVisible();
});

test("marketing and docs share the canonical brand shell", async ({ page }) => {
  await page.goto("/");
  const marketingStyles = await page.locator("body").evaluate((body) => {
    const styles = getComputedStyle(body);
    return { background: styles.backgroundColor, font: styles.fontFamily };
  });
  await expect(page.getByRole("link", { name: "Hunk home" })).toHaveAttribute("href", "/");
  await expect(page.locator(".brand-footer")).toHaveCount(1);

  await page.goto("/docs/");
  const docsStyles = await page.locator("body").evaluate((body) => {
    const styles = getComputedStyle(body);
    return { background: styles.backgroundColor, font: styles.fontFamily };
  });
  expect(docsStyles).toEqual(marketingStyles);
  const docsHeader = await page.locator(".brand-header-inner[data-context='docs']").boundingBox();
  expect(docsHeader?.width).toBe(await page.evaluate(() => window.innerWidth));
  await expect(page.getByRole("link", { name: "Hunk home" })).toHaveAttribute("href", "/");
  await expect(page.locator(".brand-nav a[href='/docs/start/install/']")).toHaveCount(1);
  await expect(page.locator(".brand-footer")).toHaveCount(0);
});

test("shared headers stay usable at narrow and tablet breakpoints", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  const marketingNavigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(marketingNavigation.getByRole("link", { name: "Discord" })).toBeHidden();
  const marketingHeader = await page.locator(".top").boundingBox();
  const marketingNav = await marketingNavigation.boundingBox();
  expect(marketingHeader).not.toBeNull();
  expect(marketingNav).not.toBeNull();
  expect(marketingNav!.y + marketingNav!.height).toBeLessThanOrEqual(
    marketingHeader!.y + marketingHeader!.height,
  );

  await page.setViewportSize({ width: 780, height: 800 });
  await page.goto("/docs/");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeHidden();
  const search = await page.getByRole("button", { name: "Search" }).boundingBox();
  const menu = await page.locator("starlight-menu-button button").boundingBox();
  expect(search).not.toBeNull();
  expect(menu).not.toBeNull();
  expect(search!.x + search!.width).toBeLessThanOrEqual(menu!.x);
});

test("install command copies with accessible feedback", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Copy: npm i -g hunkdiff" }).click();

  await expect(page.getByText("Copied to clipboard")).toHaveText("Copied to clipboard");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npm i -g hunkdiff");
});

test("theme previews switch without loading every screenshot up front", async ({ page }) => {
  await page.goto("/");
  const themePicker = page.getByRole("group", { name: "Preview theme" });
  const midnight = themePicker.getByRole("button", { name: "Midnight" });
  const midnightShot = page.getByAltText("Hunk split-view diff in the Midnight theme");

  await expect(midnight).toHaveAttribute("aria-pressed", "false");
  await expect(midnightShot).not.toHaveAttribute("src", /.+/);
  await midnight.click();
  await expect(midnight).toHaveAttribute("aria-pressed", "true");
  await expect(midnightShot).toBeVisible();
  await expect(midnightShot).toHaveAttribute("src", "/shot-midnight.webp");
});

test("community videos link out without embedding a third-party player", async ({ page }) => {
  await page.goto("/");
  const videos = page.getByRole("link", { name: /Hunk changed the way I write/ });

  await expect(videos).toHaveAttribute("href", "https://www.youtube.com/watch?v=FFfz81XM57k");
  await expect(videos.locator("img")).toHaveAttribute("src", "/video-jilles.webp");
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("community video cards read as paused embeds, not marketing tiles", async ({ page }) => {
  await page.goto("/");
  const card = page.getByRole("link", { name: /Hunk changed the way I write/ });

  // Player chrome drawn locally: duration badge on the thumbnail, quiet link-out caption.
  await expect(card.locator(".vlength")).toHaveText("5:14");
  await expect(card.locator(".vcaption")).toHaveText("Jilles · watch on YouTube");
  // The old ad-copy blurb is gone on purpose; the title lives on the player scrim.
  await expect(card.locator(".vscrim")).toContainText(
    "Hunk changed the way I write and review code with my agent",
  );
  await expect(page.locator(".vblurb")).toHaveCount(0);
});

test("the more-features list quick-hits the long tail with docs links", async ({ page }) => {
  await page.goto("/");

  const list = page.locator(".mfeats");
  await expect(list.locator("a")).toHaveCount(6);
  await expect(list.getByRole("link", { name: /Watch mode/ })).toHaveAttribute(
    "href",
    "/docs/workflows/watch-mode/",
  );
  await expect(list.getByRole("link", { name: /Extensions/ })).toHaveAttribute(
    "href",
    "/docs/extend/extensions/",
  );
  await expect(list.getByRole("link", { name: /Jujutsu & Sapling/ })).toHaveAttribute(
    "href",
    "/docs/workflows/jujutsu-and-sapling/",
  );
});

test("feature showcase leads with real TUI captures and deep-links each feature", async ({
  page,
}) => {
  await page.goto("/");

  // The review-stream still plus one clip per interactive feature.
  await expect(page.locator(".show-media img")).toHaveAttribute("src", "/feature-stream.webp");
  const clips = page.locator(".show-media video");
  await expect(clips).toHaveCount(4);
  for (const base of ["feature-agent", "feature-mouse", "feature-layout", "feature-themes"]) {
    const clip = page.locator(`.show-media video:has(source[src='/${base}.webm'])`);
    await expect(clip.locator(`source[src='/${base}.mp4']`)).toHaveCount(1);
  }

  await expect(page.getByRole("link", { name: /Agent annotations, in depth/ })).toHaveAttribute(
    "href",
    "/docs/agents/comments-and-annotations/",
  );
  await expect(page.getByRole("link", { name: /Keyboard & mouse reference/ })).toHaveAttribute(
    "href",
    "/docs/start/keyboard-and-mouse/",
  );
  await expect(page.getByRole("link", { name: /Layout & display options/ })).toHaveAttribute(
    "href",
    "/docs/configure/layout-and-display/",
  );
  await expect(page.getByRole("link", { name: /Theme gallery & config/ })).toHaveAttribute(
    "href",
    "/docs/configure/themes/",
  );
  await expect(page.getByRole("link", { name: /How reviews work/ })).toHaveAttribute(
    "href",
    "/docs/workflows/working-trees-and-commits/",
  );

  // The quotes interleave the tour as pull-quote breathers, linking out.
  const quotes = page.locator(".show-quote");
  await expect(quotes).toHaveCount(2);
  await expect(quotes.first()).toContainText("replaced any other local diff viewer");
  await expect(quotes.first().getByRole("link", { name: /Mitchell Hashimoto/ })).toHaveAttribute(
    "href",
    /x\.com\/mitchellh/,
  );
});

test("marketing page has no serious automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = results.violations.filter(
    ({ impact }) => impact === "critical" || impact === "serious",
  );

  expect(blocking).toEqual([]);
});

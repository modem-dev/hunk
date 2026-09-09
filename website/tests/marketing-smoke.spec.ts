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
  await expect(page.getByRole("tab", { name: "curl" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Copy curl install command" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Star Hunk on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/modem-dev/hunk",
  );
  await expect(page.locator(".hero-secondary")).toHaveCount(0);
});

test("install selector exposes every method without repeating the old install list", async ({
  page,
}, testInfo) => {
  await page.goto("/#install");

  const picker = page.locator("#install");
  await expect(picker).toBeVisible();
  await expect(page.locator("section.install")).toHaveCount(0);

  const methods = [
    ["curl", "curl -fsSL https://hunk.dev/install.sh | sh"],
    ["Homebrew", "brew install hunk"],
    ["npm", "npm i -g hunkdiff"],
    ["mise", "mise use -g hunk"],
    ["Nix", "nix run github:modem-dev/hunk"],
  ] as const;

  for (const [name, command] of methods) {
    const tab = page.getByRole("tab", { name });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toContainText(command);
  }

  if (!testInfo.project.name.startsWith("mobile")) {
    const pickerBounds = await picker.boundingBox();
    const tabBounds = await page.locator(".install-tabs").boundingBox();
    expect(pickerBounds).not.toBeNull();
    expect(tabBounds).not.toBeNull();
    expect(tabBounds!.width).toBeLessThan(pickerBounds!.width);
  }
});

test("install fragments initialize and follow browser history", async ({ page }) => {
  await page.goto("/#install-panel-nix");
  const nix = page.getByRole("tab", { name: "Nix" });
  await expect(nix).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("nix run github:modem-dev/hunk");

  const homebrew = page.getByRole("tab", { name: "Homebrew" });
  await homebrew.click();
  await expect(page).toHaveURL(/#install-panel-homebrew$/);
  await expect(homebrew).toHaveAttribute("aria-selected", "true");

  await nix.click();
  await expect(page).toHaveURL(/#install-panel-nix$/);
  await page.goBack();
  await expect(page).toHaveURL(/#install-panel-homebrew$/);
  await expect(homebrew).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page).toHaveURL(/#install-panel-nix$/);
  await expect(nix).toHaveAttribute("aria-selected", "true");

  await page.evaluate(() => {
    window.location.hash = "install-panel-npm";
  });
  await expect(page.getByRole("tab", { name: "npm" })).toHaveAttribute("aria-selected", "true");
});

test("install commands remain ordinary reachable content without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto("/");
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Nix" })).toHaveAttribute(
      "href",
      "#install-panel-nix",
    );
    await expect(page.locator(".install-panel")).toHaveCount(5);
    for (const panel of await page.locator(".install-panel").all())
      await expect(panel).toBeVisible();
    await expect(page.locator(".install-copy:visible")).toHaveCount(0);
    await page.getByRole("link", { name: "Nix" }).click();
    await expect(page).toHaveURL(/#install-panel-nix$/);
    await expect(page.locator("#install-panel-nix")).toContainText("nix run github:modem-dev/hunk");
  } finally {
    await context.close();
  }
});

test("install tabs support roving keyboard navigation", async ({ page }) => {
  await page.goto("/");
  const curl = page.getByRole("tab", { name: "curl" });
  await curl.focus();

  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Homebrew" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Homebrew" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.setViewportSize({ width: 320, height: 700 });
  await page.keyboard.press("End");
  const nix = page.getByRole("tab", { name: "Nix" });
  await expect(nix).toBeFocused();
  await expect
    .poll(async () => {
      const railBounds = await page.locator(".install-tab-scroll").boundingBox();
      const tabBounds = await nix.boundingBox();
      if (!railBounds || !tabBounds) return false;
      return (
        tabBounds.x >= railBounds.x - 1 &&
        tabBounds.x + tabBounds.width <= railBounds.x + railBounds.width + 1
      );
    })
    .toBe(true);
  await page.keyboard.press("Home");
  await expect(curl).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Nix" })).toBeFocused();
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

  // The nav must stay on one line at every phone width. Checking horizontal overflow alone would
  // pass while the links silently wrapped onto a second row and doubled the header height.
  for (const width of [320, 360, 375, 390, 414, 430]) {
    await page.setViewportSize({ width, height: 700 });
    const rows = await marketingNavigation.evaluate((nav) => {
      const centers = [...nav.querySelectorAll("a")]
        .filter((link) => link.getClientRects().length > 0)
        .map((link) => {
          const bounds = link.getBoundingClientRect();
          return Math.round(bounds.top + bounds.height / 2);
        });
      return new Set(centers).size;
    });
    expect(rows, `nav wrapped at ${width}px`).toBe(1);

    // Whatever else is dropped, these three always remain reachable.
    for (const name of ["Docs", "Changelog", "Star Hunk on GitHub"]) {
      await expect(marketingNavigation.getByRole("link", { name })).toBeVisible();
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `page scrolled sideways at ${width}px`).toBeLessThanOrEqual(0);
  }

  await page.setViewportSize({ width: 320, height: 700 });
  const tabRail = page.locator(".install-tab-scroll");
  const tabRailGeometry = await tabRail.evaluate((rail) => ({
    clientWidth: rail.clientWidth,
    scrollWidth: rail.scrollWidth,
  }));
  expect(tabRailGeometry.scrollWidth).toBeGreaterThan(tabRailGeometry.clientWidth);

  await page.setViewportSize({ width: 780, height: 800 });
  await page.goto("/docs/");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeHidden();
  const search = await page.getByRole("button", { name: "Search" }).boundingBox();
  const menu = await page.locator("starlight-menu-button button").boundingBox();
  expect(search).not.toBeNull();
  expect(menu).not.toBeNull();
  expect(search!.x + search!.width).toBeLessThanOrEqual(menu!.x);
});

test("selected install command copies with accessible feedback", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Copy curl install command" }).click();

  await expect(page.getByText("Copied to clipboard")).toHaveText("Copied to clipboard");
  await expect(page.locator("[data-copy-icon]").first()).toBeHidden();
  await expect(page.locator("[data-copy-success]").first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "curl -fsSL https://hunk.dev/install.sh | sh",
  );
});

test("the latest copy feedback keeps its full timeout", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.clock.install();

  const copy = page.getByRole("button", { name: "Copy curl install command" });
  await copy.click();
  await expect(copy.locator("[data-copy-success]")).toBeVisible();
  await page.clock.runFor(1200);

  await copy.click();
  await page.clock.runFor(1300);
  await expect(copy.locator("[data-copy-success]")).toBeVisible();

  await page.clock.runFor(1100);
  await expect(copy.locator("[data-copy-icon]")).toBeVisible();
});

test("copy failure gives visible recovery guidance", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new Error("clipboard unavailable")),
    });
  });

  const copy = page.getByRole("button", { name: "Copy curl install command" });
  await copy.click();
  await expect(copy.locator("[data-copy-icon]")).toBeHidden();
  await expect(copy.locator("[data-copy-failure]")).toHaveText("select");
  await expect(copy.locator("[data-copy-failure]")).toBeVisible();
  await expect(copy.locator("[data-copy-status]")).toHaveText(
    "Could not copy. Select the command manually.",
  );
});

test("the theme picker ships one shot, then warms the rest before they are clicked", async ({
  page,
}) => {
  // The document itself must carry only the visible shot: the other five are
  // ~1.4MB and would otherwise compete with first paint.
  const html = await (await page.request.get("/")).text();
  expect(html.match(/class="shot"[^>]*\ssrc="/g) ?? []).toHaveLength(1);

  await page.goto("/");
  const nordShot = page.getByAltText("Hunk split-view diff in the Nord theme");

  // Warming is scheduled for idle after load, so the unselected shots pick up
  // their source without anyone touching a pill.
  await expect(nordShot).toHaveAttribute("src", "/shot-nord.webp");
});

test("hovering a pill warms its shot ahead of the idle pass", async ({ page }) => {
  // Block the idle warm-up so only the hover path can supply the source.
  await page.addInitScript(() => {
    Object.defineProperty(window, "requestIdleCallback", { value: undefined });
    const nativeTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
      timeout === 300 ? 0 : nativeTimeout(handler, timeout, ...rest)) as typeof window.setTimeout;
  });

  await page.goto("/");
  const gruvboxShot = page.getByAltText("Hunk split-view diff in the Gruvbox theme");
  await expect(gruvboxShot).not.toHaveAttribute("src", /.+/);

  await page
    .getByRole("group", { name: "Preview theme" })
    .getByRole("button", { name: "Gruvbox" })
    .hover();
  await expect(gruvboxShot).toHaveAttribute("src", "/shot-gruvbox.webp");
});

test("theme previews switch when a pill is clicked", async ({ page }) => {
  await page.goto("/");
  const themePicker = page.getByRole("group", { name: "Preview theme" });
  const nord = themePicker.getByRole("button", { name: "Nord" });
  const nordShot = page.getByAltText("Hunk split-view diff in the Nord theme");

  await expect(nord).toHaveAttribute("aria-pressed", "false");
  await nord.click();
  await expect(nord).toHaveAttribute("aria-pressed", "true");
  await expect(nordShot).toBeVisible();
  await expect(nordShot).toHaveAttribute("src", "/shot-nord.webp");
});

test("the theme picker says how many themes it is not showing", async ({ page }) => {
  await page.goto("/");
  const picker = page.getByRole("group", { name: "Preview theme" });

  // The count is derived from Hunk's bundled catalog at build time, so this
  // asserts the shape rather than a number that legitimately grows.
  const more = picker.getByRole("link", { name: /and \d+ more/ });
  await expect(more).toHaveAttribute("href", "/docs/configure/themes/");
  const shown = await picker.getByRole("button").count();
  const label = (await more.textContent())?.match(/and (\d+) more/)?.[1];
  expect(Number(label)).toBeGreaterThan(shown);
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
  await expect(list.getByRole("link", { name: /Live sessions/ })).toHaveAttribute(
    "href",
    "/docs/agents/live-session-control/",
  );
  await expect(list.getByRole("link", { name: /Jujutsu & Sapling/ })).toHaveAttribute(
    "href",
    "/docs/workflows/jujutsu-and-sapling/",
  );
});

test("the extensions row carries a real code sample as its media", async ({ page }) => {
  await page.goto("/");

  // Extensions close the tour as an ordinary showcase row: copy left, framed
  // media right — source instead of a capture, titled with the path users drop
  // extensions into.
  const row = page.locator(".show-item").filter({ hasText: "Extend it however you want" });
  await expect(row.locator(".show-media.show-code")).toHaveCount(1);
  await expect(row.locator(".paper-bar .pt")).toHaveText("~/.config/hunk/extensions/hello.ts");
  await expect(row.locator("pre")).toContainText('from "hunkdiff/extension"');
  await expect(row.getByRole("link", { name: /Writing extensions/ })).toHaveAttribute(
    "href",
    "/docs/extend/extensions/",
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

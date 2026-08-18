import { expect, test } from "@playwright/test";

test("the changelog is reachable from the main navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  // Scoped to the brand header: Starlight's own sidebar navigation is also labelled "Main".
  const brandNav = page.getByLabel("Main navigation");
  const changelogLink = brandNav.getByRole("link", { name: "Changelog", exact: true });
  await expect(changelogLink).toBeVisible();
  await changelogLink.click();
  await expect(page.getByRole("heading", { level: 1, name: "Changelog" })).toBeVisible();

  // Narrow docs viewports drop the brand nav in favour of Starlight's menu, so the current-page
  // marker is only observable on desktop.
  if (!testInfo.project.name.startsWith("mobile")) {
    await expect(
      page.getByLabel("Main navigation").getByRole("link", { name: "Changelog", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }
});

test("the marketing header still fits its navigation on a phone", async ({ page }) => {
  await page.goto("/");
  const header = page.locator(".brand-header-inner");
  await expect(header).toBeVisible();
  // A fifth nav item must not push the header into a horizontal scroll.
  const overflow = await header.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const documentOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(documentOverflow).toBeLessThanOrEqual(0);
});

test("the landing page links the current release", async ({ page }) => {
  await page.goto("/");
  const ribbon = page.locator(".release-ribbon");
  await expect(ribbon).toBeVisible();
  // The ribbon must name a real version and resolve to that series' page.
  await expect(ribbon.locator(".rv")).toHaveText(/^v\d+\.\d+\.\d+$/);
  const href = await ribbon.getAttribute("href");
  expect(href).toMatch(/^\/changelog\/\d+\.\d+\/$/);
  const response = await page.goto(href!);
  expect(response?.ok()).toBe(true);
});

test("a release page carries its versions, dates, and install command", async ({ page }) => {
  await page.goto("/changelog/0.18/");
  await expect(page.getByRole("heading", { level: 1, name: "Hunk 0.18" })).toBeVisible();

  for (const version of ["0.18.0", "0.18.1", "0.18.2"]) {
    await expect(page.getByRole("heading", { level: 3, name: version, exact: true })).toBeVisible();
  }

  await expect(page.getByText("npm i -g hunkdiff@0.18.2")).toBeVisible();
  await expect(page.getByText("August 14, 2026", { exact: false }).first()).toBeVisible();

  // Every patch release keeps a readable anchor so a single fix can be linked directly.
  await expect(page.locator("#v0-18-2")).toHaveCount(1);
});

test("release pages link the docs pages their highlights describe", async ({ page }) => {
  await page.goto("/changelog/0.18/");
  // Scoped to the article: the docs sidebar rendered beside it links "Extensions" too.
  const docsLink = page
    .locator(".sl-markdown-content")
    .getByRole("link", { name: "Extensions", exact: true });
  await expect(docsLink).toBeVisible();
  const response = await page.goto("/docs/extend/extensions/");
  expect(response?.ok()).toBe(true);
});

test("the index lists every series newest first and links each one", async ({ page }) => {
  await page.goto("/changelog/");
  const seriesLinks = page.getByRole("heading", { level: 2 }).getByRole("link");
  const labels = await seriesLinks.allTextContents();
  expect(labels.length).toBeGreaterThan(5);
  expect(labels[0]).toBe("Hunk 0.19");

  // Exactly one series may claim to be the latest.
  await expect(page.getByText(/^Latest ·/)).toHaveCount(1);
});

test("the changelog feed and Markdown twins are served", async ({ request }) => {
  const feed = await request.get("/changelog/rss.xml");
  expect(feed.ok()).toBe(true);
  const feedBody = await feed.text();
  expect(feedBody).toContain("<title>Hunk releases</title>");
  expect(feedBody).toContain("https://hunk.dev/changelog/0.19/");
  // Undated or prerelease-only series must never reach subscribers.
  expect(feedBody).not.toContain("beta");

  const markdown = await request.get("/changelog/0.18.md");
  expect(markdown.ok()).toBe(true);
  const markdownBody = await markdown.text();
  expect(markdownBody).not.toContain("<!DOCTYPE html");
  expect(markdownBody).toContain("title: Hunk 0.18");
});

test("release notes reach the full agent corpus but not the abridged one", async ({ request }) => {
  const full = await request.get("/llms-full.txt");
  expect(full.ok()).toBe(true);
  expect(await full.text()).toContain("# Hunk 0.18");

  const small = await request.get("/llms-small.txt");
  expect(small.ok()).toBe(true);
  expect(await small.text()).not.toContain("# Hunk 0.18");
});

test("each changelog page carries its own social card", async ({ page, request }) => {
  await page.goto("/changelog/0.19/");
  const image = page.locator('meta[property="og:image"]');
  // Exactly one: the page's card must replace the site-wide image, not sit beside it.
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("content", "https://hunk.dev/changelog/og/0.19.png");
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
    "content",
    "https://hunk.dev/changelog/og/0.19.png",
  );
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
    "content",
    /^Hunk 0\.19 release notes/,
  );

  // The index gets its own card too, and both images are actually served.
  await page.goto("/changelog/");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://hunk.dev/changelog/og/index.png",
  );
  for (const path of ["/changelog/og/0.19.png", "/changelog/og/index.png"]) {
    const response = await request.get(path);
    expect(response.ok(), path).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
});

test("ordinary docs pages keep the site-wide social image", async ({ page }) => {
  await page.goto("/docs/start/install/");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://hunk.dev/og.png",
  );
});

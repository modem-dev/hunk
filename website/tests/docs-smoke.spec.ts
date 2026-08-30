import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("responsive navigation and on-page table of contents are usable", async ({
  page,
}, testInfo) => {
  await page.goto("/docs/start/quick-start/");
  await expect(page.getByRole("heading", { level: 1, name: "Quick start" })).toBeVisible();

  const mainNavigation = page.getByRole("navigation", { name: "Main" });
  const quickStartLink = mainNavigation.getByRole("link", { name: "Quick start", exact: true });
  if (testInfo.project.name.startsWith("mobile")) {
    await expect(quickStartLink).toBeHidden();
    const menu = page.locator("starlight-menu-button button");
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(quickStartLink).toBeVisible();
    await menu.click();
    const mobileToc = page.locator("#starlight__mobile-toc");
    await mobileToc.getByText("On this page", { exact: true }).click();
    await expect(mobileToc.getByRole("link", { name: "Review current work" })).toBeVisible();
  } else {
    await expect(quickStartLink).toBeVisible();
    const toc = page.getByRole("navigation", { name: "On this page" });
    await expect(toc).toBeVisible();
    await expect(toc.getByRole("link", { name: "Review current work" })).toBeVisible();
  }
});

test("documentation stays in the canonical light theme", async ({ page }) => {
  await page.goto("/docs/start/quick-start/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByLabel("Select theme")).toHaveCount(0);
  await page.goto("/docs/agents/review-with-an-agent/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("documentation includes Vercel Analytics", async ({ page }) => {
  await page.goto("/docs/");
  await expect(page.locator('script[src="/_vercel/insights/script.js"]')).toHaveCount(1);
});

test("left sidebar credits Modem at its bottom", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs/start/quick-start/");
  const sidebar = page.locator("#starlight__sidebar");
  const modem = page.getByRole("link", { name: "Built by Modem" });
  await expect(modem).toBeVisible();
  const sidebarBounds = await sidebar.boundingBox();
  const modemBounds = await modem.boundingBox();
  expect(sidebarBounds).not.toBeNull();
  expect(modemBounds).not.toBeNull();
  expect(modemBounds!.y + modemBounds!.height).toBeLessThanOrEqual(
    sidebarBounds!.y + sidebarBounds!.height,
  );
  expect(modemBounds!.y).toBeGreaterThan(sidebarBounds!.y + sidebarBounds!.height / 2);
});

test("local Pagefind search opens and returns a documentation route", async ({ page }) => {
  await page.goto("/docs/");
  const searchButton = page.getByRole("button", { name: "Search" });
  await expect(searchButton).toBeEnabled();
  await searchButton.click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  const input = dialog.locator("input");
  await input.fill("watch mode");
  await expect(dialog.getByRole("link", { name: /Watch mode/i }).first()).toBeVisible();
});

test("core documentation has no serious automated accessibility violations", async ({ page }) => {
  await page.goto("/docs/agents/review-with-an-agent/");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = results.violations.filter(
    ({ impact }) => impact === "critical" || impact === "serious",
  );

  expect(blocking).toEqual([]);
});

test("key human and machine-readable routes load", async ({ page, request }) => {
  for (const route of [
    "/docs/agents/review-with-an-agent/",
    "/docs/extend/file-previews/",
    "/docs/reference/cli/",
    "/docs/help/deployment/",
  ]) {
    const response = await page.goto(route);
    expect(response?.ok(), route).toBe(true);
    await expect(page.locator("h1")).toBeVisible();
  }

  const skill = await request.get("/docs/hunk-review-skill.md");
  expect(skill.ok()).toBe(true);
  expect(await skill.text()).toContain("# Hunk Review");
});

test("llms.txt routes expose the docs to coding agents", async ({ request }) => {
  const index = await request.get("/llms.txt");
  expect(index.ok()).toBe(true);
  const indexBody = await index.text();
  expect(indexBody).toContain("# Hunk");
  // The index is only useful if it routes agents to the two full-text variants.
  expect(indexBody).toContain("https://hunk.dev/llms-small.txt");
  expect(indexBody).toContain("https://hunk.dev/llms-full.txt");

  const full = await request.get("/llms-full.txt");
  expect(full.ok()).toBe(true);
  const fullBody = await full.text();
  expect(fullBody).toContain("# Extension API");
  expect(fullBody).toContain("# CLI reference");

  const small = await request.get("/llms-small.txt");
  expect(small.ok()).toBe(true);
  const smallBody = await small.text();
  // Extension authoring is excluded from the abridged variant; core docs are not.
  expect(smallBody).not.toContain("# Extension API");
  expect(smallBody).toContain("# CLI reference");

  // Heading anchor links must be stripped from both variants, not just the abridged one.
  expect(fullBody).not.toContain("Section titled");
  expect(smallBody).not.toContain("Section titled");

  // The `promote` globs are matched against page slugs and fail open: a docs
  // reorganization would silently drop onboarding back into alphabetical order.
  expect(fullBody.indexOf("# Install")).toBeLessThan(fullBody.indexOf("# Configuration"));

  // The static link checker only scans .html, so URLs hand-written into the llms.txt
  // config are otherwise unverified.
  for (const match of indexBody.matchAll(/https:\/\/hunk\.dev(\/[^\s)]*)/g)) {
    // Trim sentence punctuation trailing a bare URL in prose.
    const path = match[1].replace(/[.,]+$/, "");
    const linked = await request.get(path);
    expect(linked.ok(), path).toBe(true);
  }
});

test("docs pages serve their Markdown source at .md URLs", async ({ request }) => {
  const install = await request.get("/docs/start/install.md");
  expect(install.ok()).toBe(true);
  const body = await install.text();

  // Raw source, not an HTML page that merely ends in .md.
  expect(body).not.toContain("<!DOCTYPE html");
  expect(body.startsWith("---")).toBe(true);
  expect(body).toContain("title: Install");
  // Content matches the rendered page, including the default and alternative install methods.
  expect(body).toContain("```bash");
  expect(body).toContain("curl -fsSL https://hunk.dev/install.sh | sh");
  expect(body).toContain("npm install --global hunkdiff");
  expect(body).toContain("`hunk update` is the canonical way");
  expect(body).toContain("Starting with Hunk 0.20");
  expect(body).toContain("On an older Hunk release, update once");
  expect(body).toContain("warns that verification was skipped");
  expect(body).toContain("hunk update --check  # check without installing");
  expect(body).toContain("exact npm or default install-script release");
  expect(body).toContain("custom `HUNK_INSTALL_DIR`");
  expect(body.indexOf("## Install script (default)")).toBeLessThan(body.indexOf("## npm"));

  // The .md route is a companion to the HTML page, which must still render.
  const html = await request.get("/docs/start/install/");
  expect(html.ok()).toBe(true);
  expect(await html.text()).toContain("<!DOCTYPE html");

  // The plugin must not shadow the hand-authored skill file served from public/.
  const skill = await request.get("/docs/hunk-review-skill.md");
  expect(skill.ok()).toBe(true);
  expect(await skill.text()).toContain("name: hunk-review");
});

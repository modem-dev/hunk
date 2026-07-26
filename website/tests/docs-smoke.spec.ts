import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** Open responsive navigation controls when the desktop sidebar is collapsed. */
async function openMobileMenuIfNeeded(page: Page) {
  const menu = page.getByRole("button", { name: "Menu" });
  if (await menu.isVisible()) await menu.click();
}

test("responsive navigation and on-page table of contents are usable", async ({
  page,
}, testInfo) => {
  await page.goto("/docs/start/quick-start/");
  await expect(page.getByRole("heading", { level: 1, name: "Quick start" })).toBeVisible();

  const mainNavigation = page.getByRole("navigation", { name: "Main" });
  const quickStartLink = mainNavigation.getByRole("link", { name: "Quick start", exact: true });
  if (testInfo.project.name.startsWith("mobile")) {
    await expect(quickStartLink).toBeHidden();
    const menu = page.getByRole("button", { name: "Menu" });
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

test("theme choice persists while navigating", async ({ page }) => {
  await page.goto("/docs/start/quick-start/");
  await openMobileMenuIfNeeded(page);
  const picker = page.getByLabel("Select theme").filter({ visible: true });
  await picker.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/docs/agents/review-with-an-agent/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
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

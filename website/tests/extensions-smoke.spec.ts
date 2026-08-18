import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("the extension directory lists installable extensions", async ({ page }) => {
  await page.goto("/extensions/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const cards = page.locator(".xcard");
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(0);

  // Every card's action must be a command the CLI accepts, not a prose link.
  for (const command of await page.locator(".xcard [data-copy-command]").all()) {
    expect(await command.getAttribute("data-copy-command")).toMatch(
      /^hunk extension install [\w.-]+\/[\w.-]+$/,
    );
  }
});

test("the directory is reachable from the marketing navigation on desktop", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "the nav drops Extensions on phones");

  await page.goto("/");
  const link = page.getByLabel("Main navigation").getByRole("link", { name: "Extensions" });
  await link.click();
  await expect(page).toHaveURL(/\/extensions\/$/);
  await expect(
    page.getByLabel("Main navigation").getByRole("link", { name: "Extensions" }),
  ).toHaveAttribute("aria-current", "page");
});

test("the directory has no serious automated accessibility violations", async ({ page }) => {
  await page.goto("/extensions/");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = results.violations.filter(
    ({ impact }) => impact === "critical" || impact === "serious",
  );

  expect(blocking).toEqual([]);
});

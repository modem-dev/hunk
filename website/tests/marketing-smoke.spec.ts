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

test("marketing page has no serious automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = results.violations.filter(
    ({ impact }) => impact === "critical" || impact === "serious",
  );

  expect(blocking).toEqual([]);
});

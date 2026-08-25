import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("the extension directory lists installable extensions", async ({ page }) => {
  await page.goto("/extensions/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const cards = page.locator(".xcard:not([hidden])");
  expect(await cards.count()).toBeGreaterThan(0);

  // Every card's copy action must carry a command the CLI accepts.
  for (const command of await page.locator(".xcard [data-install]").all()) {
    expect(await command.getAttribute("data-install")).toMatch(
      /^hunk extension install [\w.-]+\/[\w.-]+$/,
    );
  }
});

test("search and category filters narrow the grid", async ({ page }) => {
  await page.goto("/extensions/");
  const visible = page.locator(".xcard:not([hidden])");
  const total = await visible.count();

  await page.getByLabel("Search extensions").fill("theme");
  await expect.poll(() => visible.count()).toBeLessThan(total);
  await expect(page.locator("#x-meta")).toContainText("extension");

  await page.getByLabel("Search extensions").fill("");
  await expect.poll(() => visible.count()).toBe(total);

  // A facet reports its own count, and the grid has to agree with it.
  const facet = page.locator(".xfacet", { hasText: "Pane" }).first();
  const count = Number((await facet.textContent())?.match(/(\d+)\s*$/)?.[1]);
  await facet.click();
  await expect.poll(() => visible.count()).toBe(count);

  await page.getByLabel("Search extensions").fill("no-such-extension-anywhere");
  await expect(page.locator("#x-empty")).toBeVisible();
});

test("sorting reorders the same cards without dropping any", async ({ page }) => {
  await page.goto("/extensions/");
  const visible = page.locator(".xcard:not([hidden])");
  const before = await visible.count();

  await page.getByLabel("Sort extensions").selectOption("name");
  await expect.poll(() => visible.count()).toBe(before);

  // "Name" is the one order the page can assert without live GitHub metadata,
  // and the grid sorts by moving nodes, so document order is the rendered order.
  const names = await visible.evaluateAll((cards) =>
    cards.map((card) => (card as HTMLElement).dataset.name ?? ""),
  );
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
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

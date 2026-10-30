import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const COMPARISONS = [
  "hunk-vs-delta",
  "hunk-vs-difftastic",
  "hunk-vs-diff-so-fancy",
  "hunk-vs-git-diff",
  "hunk-vs-plannotator",
] as const;

test("the hub indexes every comparison and links each one", async ({ page }) => {
  const response = await page.goto("/compare/");
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hunk vs the tools");

  const cards = page.locator("a.cmp-card");
  await expect(cards).toHaveCount(COMPARISONS.length);
  for (const slug of COMPARISONS) {
    await expect(page.locator(`a.cmp-card[href="/compare/${slug}/"]`)).toHaveCount(1);
  }
});

test("every comparison page leads with an answer, a two-sided verdict, and a table", async ({
  page,
}) => {
  for (const slug of COMPARISONS) {
    const response = await page.goto(`/compare/${slug}/`);
    expect(response?.ok(), slug).toBe(true);

    // The lead paragraph is what an answer engine quotes, so it has to be the
    // first thing after the h1 and long enough to stand on its own.
    const answer = page.locator(".cmp-answer");
    await expect(answer, slug).toBeVisible();
    expect((await answer.innerText()).length, slug).toBeGreaterThan(200);

    // Both sides get a recommendation: a page that only argues one way is the
    // kind of comparison a reader stops trusting.
    await expect(page.getByRole("heading", { name: "Choose Hunk if" }), slug).toBeVisible();
    await expect(page.locator(".pick h3"), slug).toHaveCount(2);

    const rows = page.locator(".cmp-table tbody tr");
    expect(await rows.count(), slug).toBeGreaterThan(8);

    // Every row is marked for both tools, and at least one row concedes something.
    const marks = page.locator(".cmp-table tbody td.cmp-mark");
    expect(await marks.count(), slug).toBe((await rows.count()) * 2);
    expect(
      await page.locator('.cmp-table tbody tr td.cmp-mark:nth-child(2)[data-support="no"]').count(),
      `${slug} never concedes a capability to the other tool`,
    ).toBeGreaterThan(0);

    await expect(page.locator(".faq-item"), slug).not.toHaveCount(0);
    await expect(page.locator(".cmp-sources a"), slug).not.toHaveCount(0);
  }
});

test("comparison pages carry the structured data answer engines read", async ({ page }) => {
  await page.goto("/compare/hunk-vs-delta/");

  const types = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((nodes) => nodes.map((node) => JSON.parse(node.textContent ?? "{}")["@type"]));
  expect(types).toHaveLength(3);
  expect(types).toEqual(expect.arrayContaining(["TechArticle", "FAQPage", "BreadcrumbList"]));

  const faq = await page
    .locator('script[type="application/ld+json"]')
    .nth(1)
    .evaluate((node) => JSON.parse(node.textContent ?? "{}"));
  expect(faq.mainEntity.length).toBe(await page.locator(".faq-item").count());
  // Structured-data text is plain prose: backticks belong in the rendered page.
  expect(JSON.stringify(faq)).not.toContain("`");

  // The capability table is republished as properties of each product, so an
  // answer engine reads the comparison without inferring it from a <table>.
  const article = (await page
    .locator('script[type="application/ld+json"]')
    .first()
    .evaluate((node) => JSON.parse(node.textContent ?? "{}"))) as {
    about: {
      "@type": string[];
      additionalProperty: { name: string; value: string; description?: string }[];
    }[];
  };
  const rows = await page.locator(".cmp-table tbody tr").count();
  expect(article.about).toHaveLength(2);
  for (const product of article.about) {
    // `additionalProperty` is outside SoftwareApplication's schema.org domain, so
    // the products are multi-typed; without Product a validator drops the payload.
    expect(product["@type"]).toContain("Product");
    expect(product.additionalProperty).toHaveLength(rows);
    for (const { value, description } of product.additionalProperty) {
      expect(["Yes", "Partly", "No"]).toContain(value);
      // A row note describes the row, not one product, so it is not published here.
      expect(description).toBeUndefined();
    }
  }
  expect(article.about[0].additionalProperty.map(({ name }) => name)).toEqual(
    article.about[1].additionalProperty.map(({ name }) => name),
  );
  expect(article.about[0].additionalProperty.some(({ name }) => name === "Themes")).toBe(true);

  await expect(page.locator("link[rel=canonical]")).toHaveAttribute(
    "href",
    "https://hunk.dev/compare/hunk-vs-delta/",
  );
});

test("every comparison is also served as Markdown for agents", async ({ page, request }) => {
  for (const slug of COMPARISONS) {
    const response = await request.get(`/compare/${slug}.md`);
    expect(response.ok(), slug).toBe(true);
    expect(response.headers()["content-type"], slug).toContain("text/markdown");

    const body = await response.text();
    expect(body, slug).toContain(`# Hunk vs`);
    expect(body, slug).toContain("| Capability | Hunk |");
    expect(body, slug).toContain(`https://hunk.dev/compare/${slug}/`);
  }

  await page.goto("/compare/hunk-vs-delta/");
  await expect(page.locator('link[rel=alternate][type="text/markdown"]')).toHaveAttribute(
    "href",
    "https://hunk.dev/compare/hunk-vs-delta.md",
  );
});

test("the comparison cluster is reachable from the site's own navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".brand-footer a[href='/compare/']")).toHaveCount(1);

  await page.goto("/compare/hunk-vs-delta/");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Compare");
  // Each page links every sibling, so the cluster stays crawlable from any entry point.
  await expect(page.locator("a.cmp-card")).toHaveCount(COMPARISONS.length - 1);
});

test("comparison pages have no serious automated accessibility violations", async ({ page }) => {
  for (const path of ["/compare/", ...COMPARISONS.map((slug) => `/compare/${slug}/`)]) {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter(
      ({ impact }) => impact === "critical" || impact === "serious",
    );

    expect(blocking, path).toEqual([]);
  }
});

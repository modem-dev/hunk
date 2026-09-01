import { describe, expect, test } from "bun:test";
import { BUNDLED_SHIKI_THEME_IDS } from "../src/core/theme/catalog";
import { COMPARISONS, comparisonUrl } from "../website/src/data/comparisons";

/**
 * The hunk.dev comparison catalog, held to the standard the pages claim.
 *
 * These pages make marked claims about other people's projects and tell readers
 * the marks were checked against those projects' docs. The rules below are the
 * ones a reader would notice being broken: every page recommends the other tool
 * for something, every hedged mark explains itself, and nothing quietly loses
 * its sources.
 */
describe("comparison catalog", () => {
  test("addresses each competitor at the URL people search for", () => {
    const slugs = COMPARISONS.map((comparison) => comparison.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^hunk-vs-[a-z0-9-]+$/);
  });

  test("leads with an answer that stands on its own", () => {
    for (const comparison of COMPARISONS) {
      // Answer engines quote the lead paragraph, so it has to name both tools
      // and say enough to be useful when lifted away from the page.
      expect(comparison.answer.length).toBeGreaterThan(200);
      expect(comparison.answer).toContain("Hunk");
      expect(comparison.title.length).toBeLessThanOrEqual(70);
      expect(comparison.description.length).toBeLessThanOrEqual(200);
    }
  });

  test("recommends the other tool for something on every page", () => {
    for (const comparison of COMPARISONS) {
      expect(comparison.pick.hunk.length).toBeGreaterThan(2);
      expect(comparison.pick.rival.length, comparison.slug).toBeGreaterThan(2);

      // A table Hunk sweeps is marketing, not a comparison.
      const conceded = comparison.capabilities.filter((row) => row.hunk !== "yes");
      expect(conceded.length, `${comparison.slug} concedes nothing`).toBeGreaterThan(0);
    }
  });

  test("explains every hedged mark instead of leaving a reader guessing", () => {
    for (const comparison of COMPARISONS) {
      for (const row of comparison.capabilities) {
        if (row.hunk === "partial" || row.rival === "partial") {
          expect(row.note, `${comparison.slug}: ${row.capability}`).toBeTruthy();
        }
      }
    }
  });

  test("cites where its claims came from", () => {
    for (const comparison of COMPARISONS) {
      expect(comparison.faqs.length).toBeGreaterThan(2);
      expect(comparison.sources.length).toBeGreaterThan(1);
      // At least one source is the other project's own documentation.
      expect(
        comparison.sources.some((source) => source.url.startsWith("http")),
        comparison.slug,
      ).toBe(true);
      expect(comparisonUrl(comparison)).toBe(`https://hunk.dev/compare/${comparison.slug}/`);
    }
  });

  test("evaluates themes everywhere, against the real bundled catalog", () => {
    for (const comparison of COMPARISONS) {
      const themes = comparison.capabilities.find((row) => row.capability === "Themes");

      expect(themes, `${comparison.slug} does not compare themes`).toBeDefined();
      // The note cites a count; a hard-coded one would drift silently.
      expect(themes?.note).toContain(`${BUNDLED_SHIKI_THEME_IDS.length} bundled themes`);
    }
  });
});

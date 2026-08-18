import { describe, expect, test } from "bun:test";
import { HUNK_EXTENSION_API_VERSION } from "../src/extension-api/types";
import { parseExtensionInstallSource } from "../src/extensions/manage/source";
import {
  CURRENT_EXTENSION_API_VERSION,
  EXTENSION_CATALOG,
  formatUpdated,
  installCommand,
  repositoryUrl,
} from "../website/src/data/extensions";

/**
 * The hunk.dev extension directory is hand-curated, so nothing but a test keeps
 * it honest about the CLI it tells people to run and the API version it claims
 * is current.
 */
describe("extension directory catalog", () => {
  test("states the extension API version Hunk actually ships", () => {
    expect(CURRENT_EXTENSION_API_VERSION).toBe(HUNK_EXTENSION_API_VERSION);
  });

  test("lists only extensions this Hunk can load", () => {
    for (const listing of EXTENSION_CATALOG) {
      expect(listing.apiVersion).toBeLessThanOrEqual(HUNK_EXTENSION_API_VERSION);
    }
  });

  test("publishes install commands the CLI accepts, one per repository", () => {
    const seen = new Set<string>();
    for (const listing of EXTENSION_CATALOG) {
      expect(seen.has(listing.repo)).toBe(false);
      seen.add(listing.repo);

      const spec = installCommand(listing).replace("hunk extension install ", "");
      expect(spec).toBe(listing.repo);
      expect(parseExtensionInstallSource(spec)).toMatchObject({
        cloneUrl: repositoryUrl(listing),
        name: listing.name,
      });
    }
  });

  test("describes every listing with a summary and at least one category", () => {
    for (const listing of EXTENSION_CATALOG) {
      expect(listing.summary.length).toBeGreaterThan(0);
      expect(listing.categories.length).toBeGreaterThan(0);
      expect(listing.license.length).toBeGreaterThan(0);
    }
  });

  test("phrases repository recency in coarse, human units", () => {
    const now = new Date("2026-08-18T00:00:00Z");
    expect(formatUpdated("2026-08-18T00:00:00Z", now)).toBe("today");
    expect(formatUpdated("2026-08-17T00:00:00Z", now)).toBe("yesterday");
    expect(formatUpdated("2026-08-04T00:00:00Z", now)).toBe("14 days ago");
    expect(formatUpdated("2026-06-01T00:00:00Z", now)).toBe("2 months ago");
    expect(formatUpdated("2024-06-01T00:00:00Z", now)).toBe("2 years ago");
    // A clock skewed behind the repository's own timestamp is not a negative age.
    expect(formatUpdated("2026-08-19T00:00:00Z", now)).toBeUndefined();
  });
});

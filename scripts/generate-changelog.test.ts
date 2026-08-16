import { describe, expect, test } from "bun:test";
import {
  compareVersionsDescending,
  formatDate,
  generateChangelogArtifacts,
  groupIntoSeries,
  minorSeriesOf,
  parseChangeEntry,
  parseChangelog,
  renderFeed,
  renderIndexPage,
  renderSeriesPage,
  resolveDates,
  seriesSummary,
  splitHighlights,
  toPlainText,
  truncate,
  versionAnchor,
  yamlString,
} from "./generate-changelog";

/** A changelog carrying both formats the real file mixes, plus the shapes that historically broke. */
const SAMPLE = `# Changelog

## 0.19.0

### Highlights

Hunk 0.19.0 expands the extension platform.

- **Richer extensions.** Install from Git.

### Minor Changes

- [#728](https://github.com/modem-dev/hunk/pull/728) [\`bb6405e\`](https://github.com/modem-dev/hunk/commit/bb6405e) - Highlight character ranges.

- [\`f1bc9bf\`](https://github.com/modem-dev/hunk/commit/f1bc9bf) - Move selection dialogs with review keys.

## 0.19.0-beta.0

### Patch Changes

- [#700](https://github.com/modem-dev/hunk/pull/700) [\`aaaaaaa\`](https://github.com/modem-dev/hunk/commit/aaaaaaa) - Prerelease only.

## 0.18.0

### Patch Changes

- 59fcdbb: Require an explicit click before previewing a theme.

## [0.15.3] - 2026-06-13

### Added

- Added release benchmark snapshots.

### Changed

### Fixed

- Fixed Windows launches from Cygwin.
`;

const NO_LOOKUP = () => undefined;

describe("version ordering", () => {
  test("orders releases newest first", () => {
    expect(["0.9.0", "0.18.2", "0.10.0"].sort(compareVersionsDescending)).toEqual([
      "0.18.2",
      "0.10.0",
      "0.9.0",
    ]);
  });

  test("sorts a release above its own prereleases", () => {
    expect(["0.19.0-beta.0", "0.19.0", "0.19.0-beta.1"].sort(compareVersionsDescending)).toEqual([
      "0.19.0",
      "0.19.0-beta.1",
      "0.19.0-beta.0",
    ]);
  });

  test("derives the minor series from a version", () => {
    expect(minorSeriesOf("0.18.2")).toBe("0.18");
    expect(minorSeriesOf("0.19.0-beta.0")).toBe("0.19");
  });

  test("builds a readable anchor", () => {
    expect(versionAnchor("0.18.2")).toBe("v0-18-2");
  });
});

describe("change entry parsing", () => {
  test("recovers the pull request from a Changesets entry", () => {
    expect(
      parseChangeEntry(
        "[#728](https://github.com/modem-dev/hunk/pull/728) [`bb6405e`](https://github.com/modem-dev/hunk/commit/bb6405e) - Highlight ranges.",
      ),
    ).toEqual({ description: "Highlight ranges.", pullRequest: 728 });
  });

  test("handles an entry with a commit link but no pull request", () => {
    expect(
      parseChangeEntry(
        "[`f1bc9bf`](https://github.com/modem-dev/hunk/commit/f1bc9bf) - Move keys.",
      ),
    ).toEqual({ description: "Move keys." });
  });

  test("strips the legacy bare-SHA prefix", () => {
    expect(parseChangeEntry("59fcdbb: Require an explicit click.")).toEqual({
      description: "Require an explicit click.",
    });
  });

  test("keeps plain prose untouched", () => {
    expect(parseChangeEntry("Fixed Windows launches.")).toEqual({
      description: "Fixed Windows launches.",
    });
  });
});

describe("changelog parsing", () => {
  const releases = parseChangelog(SAMPLE);

  test("parses every release newest first", () => {
    expect(releases.map((release) => release.version)).toEqual([
      "0.19.0",
      "0.19.0-beta.0",
      "0.18.0",
      "0.15.3",
    ]);
  });

  test("marks prereleases", () => {
    expect(releases.find((release) => release.version === "0.19.0-beta.0")?.prerelease).toBe(true);
    expect(releases.find((release) => release.version === "0.19.0")?.prerelease).toBe(false);
  });

  test("captures the date from a legacy heading", () => {
    expect(releases.find((release) => release.version === "0.15.3")?.headingDate).toBe(
      "2026-06-13",
    );
  });

  test("lifts Highlights out of the change sections", () => {
    const release = releases.find((entry) => entry.version === "0.19.0");
    expect(release?.highlights).toContain("expands the extension platform");
    expect(release?.sections.map((section) => section.title)).toEqual(["Minor Changes"]);
  });

  test("drops empty legacy sections rather than rendering bare headings", () => {
    const legacy = releases.find((release) => release.version === "0.15.3");
    expect(legacy?.sections.map((section) => section.title)).toEqual(["Added", "Fixed"]);
  });

  test("groups releases into minor series, newest series first", () => {
    const series = groupIntoSeries(releases);
    expect(series.map((entry) => entry.minor)).toEqual(["0.19", "0.18", "0.15"]);
    expect(series[0]?.releases.map((release) => release.version)).toEqual([
      "0.19.0",
      "0.19.0-beta.0",
    ]);
  });
});

describe("highlights", () => {
  test("separates the lead paragraph from the bullets", () => {
    expect(splitHighlights("A lead sentence.\n\n- **One.** Detail.")).toEqual({
      lead: "A lead sentence.",
      body: "- **One.** Detail.",
    });
  });

  test("treats a bullet-only block as having no lead", () => {
    expect(splitHighlights("- **One.** Detail.")).toEqual({ body: "- **One.** Detail." });
  });

  test("uses the changelog lead as the series summary", () => {
    const series = groupIntoSeries(parseChangelog(SAMPLE))[0];
    expect(series && seriesSummary(series, undefined)).toBe(
      "Hunk 0.19.0 expands the extension platform.",
    );
  });

  test("prefers a hand-authored summary over the changelog lead", () => {
    const series = groupIntoSeries(parseChangelog(SAMPLE))[0];
    expect(series && seriesSummary(series, { summary: "Overlay wins." })).toBe("Overlay wins.");
  });

  test("reports no summary when a series has no highlights", () => {
    const series = groupIntoSeries(parseChangelog(SAMPLE)).find((entry) => entry.minor === "0.15");
    expect(series && seriesSummary(series, undefined)).toBeUndefined();
  });
});

describe("date resolution", () => {
  const releases = parseChangelog(SAMPLE);

  test("never recomputes a date that is already recorded", () => {
    const resolved = resolveDates(releases, { "0.19.0": "2020-01-01" }, () => "2099-12-31");
    expect(resolved["0.19.0"]).toBe("2020-01-01");
  });

  test("fills a missing date from the tag lookup", () => {
    const resolved = resolveDates(releases, {}, (version) =>
      version === "0.19.0" ? "2026-08-16" : undefined,
    );
    expect(resolved["0.19.0"]).toBe("2026-08-16");
  });

  test("prefers a legacy heading date over the tag lookup", () => {
    const resolved = resolveDates(releases, {}, () => "2099-12-31");
    expect(resolved["0.15.3"]).toBe("2026-06-13");
  });

  test("leaves a version undated when nothing can resolve it", () => {
    expect(resolveDates(releases, {}, NO_LOOKUP)["0.19.0"]).toBeUndefined();
  });

  test("orders the recorded map newest first so the committed file stays stable", () => {
    const resolved = resolveDates(
      releases,
      { "0.18.0": "2026-08-08", "0.19.0": "2026-08-16" },
      NO_LOOKUP,
    );
    expect(Object.keys(resolved)).toEqual(["0.19.0", "0.18.0", "0.15.3"]);
  });
});

describe("text helpers", () => {
  test("reduces Markdown to plain text", () => {
    expect(toPlainText("Use **`hunk diff`** and [the docs](/docs/).")).toBe(
      "Use hunk diff and the docs.",
    );
  });

  test("truncates on a word boundary", () => {
    expect(truncate("one two three four", 12)).toBe("one two…");
  });

  test("leaves short text alone", () => {
    expect(truncate("short", 12)).toBe("short");
  });

  test("quotes a frontmatter scalar the way the repository formatter would", () => {
    // Generated pages must survive `bun run format` untouched, or `--check` calls them stale.
    expect(yamlString("plain text")).toBe('"plain text"');
    expect(yamlString('vcs = "jj" support')).toBe(`'vcs = "jj" support'`);
    expect(yamlString(`Hunk's "jj" support`)).toBe('"Hunk\'s \\"jj\\" support"');
  });

  test("formats an ISO date", () => {
    expect(formatDate("2026-08-16")).toBe("August 16, 2026");
  });
});

describe("series page", () => {
  const series = groupIntoSeries(parseChangelog(SAMPLE))[0];
  const dates = { "0.19.0": "2026-08-16", "0.19.0-beta.0": "2026-08-10" };

  test("renders the install command for the newest published release", () => {
    const page = series && renderSeriesPage({ series, notes: undefined, dates });
    expect(page).toContain("npm i -g hunkdiff@0.19.0");
  });

  test("omits the install command while the release is still unpublished", () => {
    const page = series && renderSeriesPage({ series, notes: undefined, dates: {} });
    expect(page).not.toContain("npm i -g");
    expect(page).toContain("Unreleased");
  });

  test("never offers a prerelease as the install target", () => {
    const page =
      series &&
      renderSeriesPage({ series, notes: undefined, dates: { "0.19.0-beta.0": "2026-08-10" } });
    expect(page).not.toContain("npm i -g");
  });

  test("marks the series current only when it holds the latest release", () => {
    const current =
      series &&
      renderSeriesPage({ series, notes: undefined, dates, latestReleasedVersion: "0.19.0" });
    const superseded =
      series &&
      renderSeriesPage({ series, notes: undefined, dates, latestReleasedVersion: "0.20.0" });
    expect(current).toContain("This is the current release");
    expect(superseded).toContain("no longer the current release");
  });

  test("emits a stable anchor and a labelled prerelease", () => {
    const page = series && renderSeriesPage({ series, notes: undefined, dates });
    expect(page).toContain('<a id="v0-19-0-beta-0"></a>');
    expect(page).toContain("prerelease");
  });

  test("does not repeat the lead paragraph inside Highlights", () => {
    const page = series && renderSeriesPage({ series, notes: undefined, dates });
    const highlights = page?.split("## Highlights")[1]?.split("\n## ")[0];
    expect(highlights).toContain("**Richer extensions.**");
    expect(highlights).not.toContain("expands the extension platform");
  });

  test("links the neighbouring series", () => {
    const page =
      series && renderSeriesPage({ series, notes: undefined, dates, older: "0.18", newer: "0.20" });
    expect(page).toContain("[Older: Hunk 0.18](/changelog/0.18/)");
    expect(page).toContain("[Newer: Hunk 0.20](/changelog/0.20/)");
  });

  test("pins the published URL so Astro does not strip the dot", () => {
    const page = series && renderSeriesPage({ series, notes: undefined, dates });
    expect(page).toContain("slug: changelog/0.19");
  });
});

describe("index page", () => {
  const seriesList = groupIntoSeries(parseChangelog(SAMPLE));
  const dates = { "0.19.0": "2026-08-16", "0.18.0": "2026-08-08", "0.15.3": "2026-06-13" };

  test("marks only the newest series as latest", () => {
    const page = renderIndexPage({ seriesList, notes: {}, dates });
    expect(page.split("Latest ·").length - 1).toBe(1);
  });

  test("counts published releases and changes per series", () => {
    const page = renderIndexPage({ seriesList, notes: {}, dates });
    expect(page).toContain("Latest · August 16, 2026 · 1 release · 3 changes");
  });

  test("omits a summary paragraph for a series with no editorial summary", () => {
    const page = renderIndexPage({ seriesList, notes: {}, dates });
    expect(page).not.toContain("Release notes for Hunk 0.15:");
  });

  test("links every series", () => {
    const page = renderIndexPage({ seriesList, notes: {}, dates });
    for (const minor of ["0.19", "0.18", "0.15"]) {
      expect(page).toContain(`## [Hunk ${minor}](/changelog/${minor}/)`);
    }
  });
});

describe("feed", () => {
  const seriesList = groupIntoSeries(parseChangelog(SAMPLE));

  test("emits one dated item per published series", () => {
    const feed = renderFeed({
      seriesList,
      notes: {},
      dates: { "0.19.0": "2026-08-16", "0.18.0": "2026-08-08" },
    });
    expect(feed.split("<item>").length - 1).toBe(2);
    expect(feed).toContain("<link>https://hunk.dev/changelog/0.19/</link>");
    expect(feed).toContain("Sun, 16 Aug 2026 00:00:00 GMT");
  });

  test("skips a series whose only dated release is a prerelease", () => {
    const feed = renderFeed({ seriesList, notes: {}, dates: { "0.19.0-beta.0": "2026-08-10" } });
    expect(feed).not.toContain("<item>");
  });

  test("escapes XML in summaries", () => {
    const feed = renderFeed({
      seriesList,
      notes: { "0.19": { summary: 'Fixes <script> & "quotes".' } },
      dates: { "0.19.0": "2026-08-16" },
    });
    expect(feed).toContain("Fixes &lt;script&gt; &amp; &quot;quotes&quot;.");
  });
});

describe("artifacts", () => {
  const artifacts = generateChangelogArtifacts({
    markdown: SAMPLE,
    notes: {},
    recordedDates: { "0.19.0": "2026-08-16", "0.18.0": "2026-08-08", "0.15.3": "2026-06-13" },
    lookupDate: NO_LOOKUP,
  });
  const paths = Object.keys(artifacts).map((path) => path.split(/[\\/]/).slice(-2).join("/"));

  test("writes one page per series plus the index, feed, and data files", () => {
    expect(paths).toContain("changelog/0.19.md");
    expect(paths).toContain("changelog/0.18.md");
    expect(paths).toContain("changelog/0.15.md");
    expect(paths).toContain("changelog/index.md");
    expect(paths).toContain("changelog/rss.xml");
    expect(paths).toContain("releases/dates.json");
    expect(paths).toContain("releases/latest.json");
  });

  test("records the newest published release for the landing page", () => {
    const latest = Object.entries(artifacts).find(([path]) => path.endsWith("latest.json"))?.[1];
    expect(JSON.parse(latest ?? "null")).toMatchObject({ version: "0.19.0", minor: "0.19" });
  });

  test("reports no latest release when nothing is published yet", () => {
    // Legacy headings carry their own dates, so an all-Changesets changelog is what actually
    // exercises the pre-tag state a release-preparation branch generates from.
    const unpublished = generateChangelogArtifacts({
      markdown: "# Changelog\n\n## 0.19.0\n\n### Patch Changes\n\n- 1234567: Something.\n",
      notes: {},
      recordedDates: {},
      lookupDate: NO_LOOKUP,
    });
    const latest = Object.entries(unpublished).find(([path]) => path.endsWith("latest.json"))?.[1];
    expect(JSON.parse(latest ?? '"missing"')).toBeNull();
  });

  test("generates identical output when run twice", () => {
    const again = generateChangelogArtifacts({
      markdown: SAMPLE,
      notes: {},
      recordedDates: { "0.19.0": "2026-08-16", "0.18.0": "2026-08-08", "0.15.3": "2026-06-13" },
      lookupDate: NO_LOOKUP,
    });
    expect(again).toEqual(artifacts);
  });
});

describe("the pre-tag window", () => {
  // A release-preparation branch adds a CHANGELOG.md section before the tag and npm publication
  // exist. The site builds from that branch, so the unreleased series must not claim to be current
  // or hand out an install command for a version nobody can install yet.
  const seriesList = groupIntoSeries(parseChangelog(SAMPLE));
  const dates = { "0.18.0": "2026-08-08", "0.15.3": "2026-06-13" };

  test("marks the published series latest, not the unreleased one", () => {
    const page = renderIndexPage({ seriesList, notes: {}, dates });
    const [newest, published] = page.split("## [Hunk ").slice(1, 3);
    expect(newest).toContain("Unreleased");
    expect(newest).not.toContain("Latest");
    expect(published).toContain("Latest");
  });

  test("keeps the unreleased series out of the feed", () => {
    const feed = renderFeed({ seriesList, notes: {}, dates });
    expect(feed).not.toContain("/changelog/0.19/");
    expect(feed).toContain("/changelog/0.18/");
  });

  test("still points the landing page at the published release", () => {
    const artifacts = generateChangelogArtifacts({
      markdown: SAMPLE,
      notes: {},
      recordedDates: dates,
      lookupDate: NO_LOOKUP,
    });
    const latest = Object.entries(artifacts).find(([path]) => path.endsWith("latest.json"))?.[1];
    expect(JSON.parse(latest ?? "null")).toMatchObject({ version: "0.18.0", minor: "0.18" });
  });
});

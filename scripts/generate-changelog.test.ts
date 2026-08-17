import { describe, expect, test } from "bun:test";
import {
  buildIndexCard,
  buildSeriesCard,
  compareVersionsDescending,
  findMissingCardImages,
  formatDate,
  formatJson,
  generateChangelogArtifacts,
  groupIntoSeries,
  isPublished,
  minorSeriesOf,
  parseChangeEntry,
  parseChangelog,
  renderFeed,
  renderIndexPage,
  renderSeriesPage,
  resolveDates,
  seriesSummary,
  socialCardPath,
  splitHighlights,
  toPlainText,
  truncate,
  updateGeneratedChangelog,
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

  test("offers Homebrew only on the current release, which is all it can install", () => {
    const current =
      series &&
      renderSeriesPage({ series, notes: undefined, dates, latestReleasedVersion: "0.19.0" });
    const superseded =
      series &&
      renderSeriesPage({ series, notes: undefined, dates, latestReleasedVersion: "0.20.0" });
    expect(current).toContain("brew update && brew upgrade hunk");
    expect(superseded).not.toContain("brew");
    expect(superseded).toContain("npm i -g hunkdiff@0.19.0");
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

  test("emits a stable anchor for each release", () => {
    const page = series && renderSeriesPage({ series, notes: undefined, dates });
    expect(page).toContain('<a class="release-separator" id="v0-19-0"></a>');
  });

  test("omits a body summary when none was written, keeping it in the description", () => {
    const bare = groupIntoSeries(parseChangelog("## 0.9.0\n\n### Fixed\n\n- A fix.\n"))[0];
    const page = bare && renderSeriesPage({ series: bare, notes: undefined, dates: {} });
    expect(page).toContain('description: "Release notes for Hunk 0.9');
    const body = page?.split("-->")[1]?.split("## ")[0] ?? "";
    expect(body).not.toContain("Release notes for Hunk 0.9");
  });

  test("opens with a dateline and suppresses the edit link on generated pages", () => {
    const page = series && renderSeriesPage({ series, notes: undefined, dates });
    expect(page).toContain("editUrl: false");
    expect(page).toContain("August 16, 2026 · 1 release");
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

  test("keeps the intro to the two off-page links", () => {
    const page = renderIndexPage({ seriesList, notes: {}, dates });
    const intro = page.split("---")[2]?.split("## ")[0] ?? "";
    expect(intro).toContain("[RSS](https://hunk.dev/changelog/rss.xml)");
    expect(intro).toContain("CHANGELOG.md");
    expect(intro).not.toContain("newest first");
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

describe("parser robustness", () => {
  // Regression coverage for the shapes a future changeset can legitimately contain. Each of these
  // previously either lost content silently or produced malformed output.
  test("keeps a fenced code block containing a heading out of the document structure", () => {
    const releases = parseChangelog(
      [
        "## 0.20.0",
        "",
        "### Minor Changes",
        "",
        "- [#1](https://x/pull/1) - Example output:",
        "",
        "```md",
        "## Not a heading",
        "- not a bullet",
        "```",
        "",
        "### Patch Changes",
        "",
        "- [#2](https://x/pull/2) - Second entry.",
        "",
      ].join("\n"),
    );
    expect(releases).toHaveLength(1);
    // The section after the fence must survive rather than being swallowed by a fake heading.
    expect(releases[0]?.sections.map((section) => section.title)).toEqual([
      "Minor Changes",
      "Patch Changes",
    ]);
    expect(releases[0]?.sections[1]?.entries[0]?.pullRequest).toBe(2);
  });

  test("closes a fence only on its own delimiter", () => {
    const releases = parseChangelog(
      [
        "## 0.20.0",
        "",
        "### Patch Changes",
        "",
        "- One:",
        "",
        "~~~",
        "```",
        "## x",
        "~~~",
        "",
      ].join("\n"),
    );
    expect(releases[0]?.sections[0]?.entries).toHaveLength(1);
  });

  test("rejects a heading that only starts with a version", () => {
    expect(parseChangelog("## 1.2.3 (hotfix) <script>x</script>\n\n- a: b\n")).toEqual([]);
    expect(parseChangelog("## 1.2.3\n\n### Fixed\n\n- Real.\n").map((r) => r.version)).toEqual([
      "1.2.3",
    ]);
  });

  test("accepts a prerelease heading", () => {
    expect(
      parseChangelog("## 0.20.0-beta.10\n\n### Fixed\n\n- Real.\n").map((r) => r.version),
    ).toEqual(["0.20.0-beta.10"]);
  });

  test("keeps a nested sub-list as a list instead of run-on prose", () => {
    const releases = parseChangelog(
      ["## 0.20.0", "", "### Minor Changes", "", "- Adds:", "  - one", "  - two", ""].join("\n"),
    );
    const description = releases[0]?.sections[0]?.entries[0]?.description ?? "";
    expect(description).toContain("\n  - one");
    expect(description).not.toContain("Adds: - one");
  });
});

describe("prerelease ordering", () => {
  test("never returns NaN from the comparator", () => {
    for (const [a, b] of [
      ["0.19.0-rc", "0.19.0"],
      ["0.19.0-rc", "0.19.0-beta.1"],
      ["0.19.0", "0.19.0"],
    ] as const) {
      expect(Number.isFinite(compareVersionsDescending(a, b))).toBe(true);
    }
  });

  test("sorts a release above a prerelease with no trailing number", () => {
    expect(["0.19.0-rc", "0.19.0-beta.1", "0.19.0"].sort(compareVersionsDescending)).toEqual([
      "0.19.0",
      "0.19.0-rc",
      "0.19.0-beta.1",
    ]);
  });

  test("orders prerelease channels and their numbers", () => {
    expect(
      ["0.19.0-alpha.99", "0.19.0-beta.2", "0.19.0-beta.10"].sort(compareVersionsDescending),
    ).toEqual(["0.19.0-beta.10", "0.19.0-beta.2", "0.19.0-alpha.99"]);
  });
});

describe("published-release policy", () => {
  const dated = { version: "0.19.0", prerelease: false, sections: [] };
  const prerelease = { version: "0.19.0-beta.0", prerelease: true, sections: [] };

  test("requires a real release with a recorded date", () => {
    expect(isPublished(dated, { "0.19.0": "2026-08-16" })).toBe(true);
    expect(isPublished(dated, {})).toBe(false);
    expect(isPublished(prerelease, { "0.19.0-beta.0": "2026-08-10" })).toBe(false);
  });
});

describe("video embedding", () => {
  const series = groupIntoSeries(parseChangelog(SAMPLE))[0];
  const dates = { "0.19.0": "2026-08-16" };

  test("renders the video and its schema when the overlay declares one", () => {
    const page = series && renderSeriesPage({ series, notes: { video: { mp4: "/v.mp4" } }, dates });
    expect(page).toContain('<source src="/v.mp4" type="video/mp4" />');
    expect(page).toContain("application/ld+json");
    expect(page).toContain('"@type":"VideoObject"');
  });

  test("escapes a title that would otherwise close the script element", () => {
    const page =
      series &&
      renderSeriesPage({
        series,
        notes: { video: { mp4: "/v.mp4", title: "</script><script>alert(1)</script>" } },
        dates,
      });
    expect(page).not.toContain("</script><script>alert(1)");
    expect(page).toContain("\\u003c/script");
  });

  test("escapes a quote in a source URL rather than breaking the attribute", () => {
    const page =
      series &&
      renderSeriesPage({ series, notes: { video: { mp4: '/v.mp4" onerror="x' } }, dates });
    expect(page).not.toContain('onerror="x"');
    expect(page).toContain("&quot;");
  });
});

describe("orphan cleanup safety", () => {
  test("refuses to remove most of the generated pages", () => {
    // A collapsed parse would otherwise delete every committed page on a plain generate run.
    // `check` mode never writes, so this asserts the guard without touching the tree.
    expect(() => updateGeneratedChangelog({ check: true, artifacts: {} })).toThrow(
      /Refusing to remove/,
    );
  });

  test("still reports genuinely stale output", () => {
    const artifacts = generateChangelogArtifacts();
    const [firstPath] = Object.keys(artifacts);
    expect(firstPath).toBeDefined();
    expect(
      updateGeneratedChangelog({
        check: true,
        artifacts: { ...artifacts, [firstPath as string]: "stale" },
      }),
    ).toEqual([firstPath as string]);
  });
});

describe("prereleases stay on GitHub", () => {
  // Betas are published as GitHub releases only. Filtering them at the artifact boundary keeps
  // them out of every surface at once rather than relying on each renderer to skip them.
  const artifacts = generateChangelogArtifacts({
    markdown: SAMPLE,
    notes: {},
    recordedDates: { "0.19.0": "2026-08-16", "0.19.0-beta.0": "2026-08-10" },
    lookupDate: NO_LOOKUP,
  });
  const page = Object.entries(artifacts).find(([path]) => path.endsWith("0.19.md"))?.[1] ?? "";

  test("renders no prerelease section on the series page", () => {
    expect(page).toContain("### 0.19.0");
    expect(page).not.toContain("0.19.0-beta.0");
    expect(page).not.toContain("prerelease");
  });

  test("counts only real releases in the dateline", () => {
    expect(page).toContain("1 release");
  });

  test("prunes prerelease dates from the committed map", () => {
    const recorded = Object.entries(artifacts).find(([path]) =>
      path.endsWith("dates.json"),
    )?.[1] as string;
    // 0.15.3 keeps its legacy heading date; only the prerelease is dropped.
    expect(JSON.parse(recorded)).toEqual({ "0.19.0": "2026-08-16", "0.15.3": "2026-06-13" });
  });

  test("publishes no page at all for a series that has only reached beta", () => {
    const betaOnly = generateChangelogArtifacts({
      markdown: "# Changelog\n\n## 0.20.0-beta.0\n\n### Patch Changes\n\n- 1234567: Early.\n",
      notes: {},
      recordedDates: { "0.20.0-beta.0": "2026-09-01" },
      lookupDate: NO_LOOKUP,
    });
    expect(Object.keys(betaOnly).some((path) => path.endsWith("0.20.md"))).toBe(false);
  });
});

describe("link reference definitions", () => {
  // CHANGELOG.md closes with a block of `[0.9.1]: https://…` definitions linking every legacy
  // heading to its compare view. They belong to no release and previously folded into the prose of
  // the oldest release's last entry, publishing the whole table as release text.
  const withReferences = [
    "## 0.1.0",
    "",
    "### Fixed",
    "",
    "- Stabilized diff repainting.",
    "",
    "[Unreleased]: https://github.com/modem-dev/hunk/compare/v0.15.3...HEAD",
    "[0.1.0]: https://github.com/modem-dev/hunk/tree/v0.1.0",
    "",
  ].join("\n");

  test("keeps the reference block out of the last entry", () => {
    const entries = parseChangelog(withReferences)[0]?.sections[0]?.entries ?? [];
    expect(entries).toEqual([{ description: "Stabilized diff repainting." }]);
  });

  test("keeps it out of a Highlights block too", () => {
    const releases = parseChangelog(
      [
        "## 0.1.0",
        "",
        "### Highlights",
        "",
        "A lead.",
        "",
        "[0.1.0]: https://x/tree/v0.1.0",
        "",
      ].join("\n"),
    );
    expect(releases[0]?.highlights).toBe("A lead.");
  });

  test("still treats one inside a fence as content", () => {
    const entries =
      parseChangelog(
        [
          "## 0.1.0",
          "",
          "### Fixed",
          "",
          "- Document the reference syntax:",
          "",
          "```md",
          "[label]: https://example.com",
          "```",
          "",
        ].join("\n"),
      )[0]?.sections[0]?.entries ?? [];
    expect(entries[0]?.description).toContain("[label]: https://example.com");
  });
});

describe("social cards", () => {
  const seriesList = groupIntoSeries(parseChangelog(SAMPLE).filter((r) => !r.prerelease));
  const dates = { "0.19.0": "2026-08-16", "0.18.0": "2026-08-08", "0.15.3": "2026-06-13" };
  const card = (minor: string, latest = false) => {
    const series = seriesList.find((entry) => entry.minor === minor);
    if (!series) throw new Error(`no series ${minor}`);
    return buildSeriesCard({ series, notes: undefined, dates, latest });
  };

  test("names the image after the published slug", () => {
    expect(socialCardPath("0.18")).toBe("/changelog/og/0.18.png");
    expect(socialCardPath("index")).toBe("/changelog/og/index.png");
  });

  test("marks only the latest series", () => {
    expect(card("0.19", true).latest).toBe(true);
    expect(card("0.18").latest).toBeUndefined();
  });

  test("omits the tagline when no summary was written", () => {
    expect(card("0.19", true).tagline).toBe("Hunk 0.19.0 expands the extension platform.");
    // 0.15 is the legacy-format series, which has no Highlights block.
    expect(card("0.15").tagline).toBeUndefined();
  });

  test("carries counts and a date span in the meta line", () => {
    expect(card("0.19", true).meta).toBe("August 16, 2026 · 1 release · 2 changes");
  });

  test("shows chips only when a series has more than one published release", () => {
    expect(card("0.19", true).chips).toBeUndefined();
  });

  test("describes itself for screen readers and link previews", () => {
    expect(card("0.18").alt).toBe(
      "Hunk 0.18 release notes — August 8, 2026 · 1 release · 1 change",
    );
  });

  test("summarises the whole history on the index card", () => {
    const index = buildIndexCard(seriesList, dates);
    expect(index).toMatchObject({ slug: "index", title: "Changelog" });
    expect(index.meta).toBe("3 release series · June 2026 – August 2026");
    expect(index.chips).toEqual(["0.19", "0.18", "0.15", "…"]);
  });

  test("points each page at its own card instead of the site-wide image", () => {
    const series = seriesList[0];
    const page =
      series &&
      renderSeriesPage({
        series,
        notes: undefined,
        dates,
        card: card("0.19", true),
      });
    expect(page).toContain("property: og:image");
    expect(page).toContain("https://hunk.dev/changelog/og/0.19.png");
    expect(page).toContain("name: twitter:image");
    expect(page).toContain("property: og:image:alt");
  });

  test("reports a card whose image has not been drawn", () => {
    expect(findMissingCardImages([{ slug: "9.9", title: "x", meta: "y", alt: "z" }])).toEqual([
      expect.stringContaining("9.9.png"),
    ]);
    expect(findMissingCardImages([{ slug: "0.19", title: "x", meta: "y", alt: "z" }])).toEqual([]);
  });
});

describe("generated JSON survives the repository formatter", () => {
  // oxfmt keeps a primitive array on one line while it fits in 100 columns and expands past it.
  // Emitting anything else makes `bun run format` rewrite the file and `--check` call it stale.
  test("keeps a short primitive array inline", () => {
    expect(formatJson({ chips: ["0.18.2", "0.18.1"] })).toBe(
      '{\n  "chips": ["0.18.2", "0.18.1"]\n}',
    );
  });

  test("expands an array that would cross the print width", () => {
    const long = Array.from({ length: 14 }, (_, index) => `0.17.${index}`);
    const printed = formatJson({ chips: long });
    expect(printed).toContain('"chips": [\n');
    for (const line of printed.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  test("always expands objects and arrays of objects", () => {
    expect(formatJson([{ a: 1 }])).toBe('[\n  {\n    "a": 1\n  }\n]');
  });

  test("drops undefined members rather than emitting them", () => {
    expect(formatJson({ a: 1, b: undefined })).toBe('{\n  "a": 1\n}');
  });

  test("renders empty containers compactly", () => {
    expect(formatJson({ a: [], b: {} })).toBe('{\n  "a": [],\n  "b": {}\n}');
  });
});

# Release notes on hunk.dev

`CHANGELOG.md` is the source of truth for what shipped. `scripts/generate-changelog.ts` projects it
into the pages published at `hunk.dev/changelog`, the same way `scripts/generate-docs.ts` projects
runtime metadata into the CLI and config references. Nothing under the generated paths is
hand-edited; `bun run check:changelog` fails the build when they drift.

## Why the site carries release notes

Hunk publishes 40-plus releases at roughly two a week, and before this that content existed only in
`CHANGELOG.md` and GitHub Releases — about a quarter as much prose as the whole docs site, none of it
on hunk.dev. Three things follow from hosting it here:

- **Release cadence becomes a freshness signal** for a site that is otherwise mostly static docs.
- **Answer engines can finally answer version questions.** The site already ships `llms.txt`,
  `llms-full.txt`, a `.md` twin of every page, and an explicit crawler allow-list; release history
  was the largest gap in that corpus. Changelog pages join `llms-full.txt` automatically and are
  excluded from `llms-small.txt`, which stays scoped to learning Hunk.
- **Release videos get a permanent home.** `skills/hunk-launch-video` renders the real TUI for every
  release; a GitHub attachment URL is unindexable and unembeddable.

## One page per minor series

`/changelog/0.18/` covers 0.18.0 and every patch after it, rather than one page per version. Half of
all releases are single-bullet patches, and a URL per version would produce mostly thin pages that
rank for nothing. Grouping yields around twenty substantial pages and matches how the question is
asked — what is in 0.18, not what is in 0.18.2.

Dated prereleases publish on the same series page as stable releases. A series that has only reached
beta gets its page, index row, feed item, and social card as soon as the prerelease tag supplies a
date, while an undated prerelease preparation remains invisible. Prereleases never advance the
stable `Latest` marker, landing-page ribbon, or default install command.

```text
/changelog/                 index over every series
/changelog/0.18/            series page
/changelog/0.18/#v0-18-2    stable per-release anchor
/changelog/0.21/#v0-21-0-beta-0 prerelease anchor
/changelog/rss.xml          feed, one stable item per series plus one item per prerelease
/changelog/0.18.md          Markdown twin, via starlight-dot-md
```

Astro slugifies filenames and would publish `0.18.md` at `/changelog/018/`, so every series page
pins its URL with an explicit `slug` in frontmatter. Astro also derives `#0182` from a version
heading, so each release emits a readable `v0-18-2` anchor beside its heading.

## Inputs

| Path                           | Owner         | Contents                                                                                                |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                 | Changesets    | Every release, in both the Changesets format and the pre-0.16 Keep a Changelog format. Both are parsed. |
| `website/releases/notes.json`  | Hand-authored | Per-series `summary`, `tagline`, `links`, and `video`. Every field optional.                            |
| `website/releases/dates.json`  | Generator     | Version to release date. Committed.                                                                     |
| `website/releases/latest.json` | Generator     | Newest published stable release, imported by the landing-page ribbon.                                   |
| `website/releases/cards.json`  | Generator     | Content of each social card, read by the card renderer.                                                 |

The `### Highlights` block in `CHANGELOG.md` is already hand-written for minor releases, so the page
uses it directly: its lead paragraph becomes the page summary and its bullets become the Highlights
section. The overlay only adds what the changelog has no place for.

## Dates and the pre-tag window

The Changesets format carries no dates, and the release tag does not exist when
`bun run release:version` runs — the version-preparation branch is generated, reviewed, and merged
before the tag is pushed. So the site can build from a commit describing a version that nobody can
install yet.

Two rules handle this without a draft state or an extra publication step:

- **A recorded date is never recomputed.** Dates live in `website/releases/dates.json`; only a
  version missing from it reads the annotated tag's publication date, falling back to the tagged
  commit date for a lightweight tag; either lookup fails soft. Generation is therefore deterministic,
  and `check:changelog` gates CI on Vercel's shallow, tagless
  checkout without touching Git.
- **Publication state is derived from dates, not from position.** An undated stable version renders
  as `Unreleased`; an undated prerelease remains off every surface until its tag exists. Neither can
  advance the index's `Latest` marker, enter the feed, or contribute an install command. Stable notes
  are accurate when their preparation branch merges, while beta notes appear only once installable.

`website/releases/dates.json` is rebuilt from the release list rather than merged onto it, so a
version that leaves `CHANGELOG.md` does not linger in the committed map. Stable and prerelease tag
dates are both retained.

Step 4 of `skills/hunk-release/SKILL.md` regenerates after every tag, including backports. Every tag
backfills its date and publishes its notes; only the newest stable tag adds the default install command and advances the
landing-page ribbon. RSS keeps one mutable item per stable series and gives every prerelease an
exact-version anchor and GUID, so the later stable release still reaches subscribers as a new item.

## Surfaces

The generator emits Markdown only, so the pages stay clean for the `.md` twin and the agent corpus.
Presentation lives in the site:

- `BrandHeader.astro` carries the nav item; `DocsHeader.astro` derives the active item from the
  route, because Starlight renders the changelog and the docs through the same shell.
- `DocsMarkdownContent.astro` marks changelog articles with `data-changelog`, which is what lets
  `starlight.css` style the generated structure — an h3 per version, a meta line, h4 change sections
  — as a release list without per-page markup. Starlight renders headings inline inside a wrapper,
  so the rule between releases sits on the generated `.release-separator` anchor rather than on the
  heading, where a border would span only its text.
- Generated pages set `editUrl: false`; an edit link would invite hand-edits that regeneration
  silently overwrites.
- The landing page imports `website/releases/latest.json` for its release ribbon, so the current
  version is a static import rather than a build-time parse of generated Markdown.

`vercel.json` must keep `CHANGELOG.md` and `scripts/generate-changelog.ts` in its `ignoreCommand`
path list, or release commits will not trigger a deploy.

## Social cards

Every changelog page carries its own OpenGraph image instead of the site-wide `og.png`, because a
release announcement is the most-shared page the site has.

`bun run generate:changelog` derives what belongs on each card into `website/releases/cards.json`,
and each page's frontmatter `head` points at `/changelog/og/<slug>.png`. A beta-only card labels its
metadata as `Prerelease` instead of receiving the stable `Latest` pill. Starlight merges page head
entries over the global ones by tag and property, so a changelog page replaces the site-wide image
while ordinary docs pages keep it.

`bun run generate:og` paints the cards with Chromium at 1200x630 and commits them. Rendering needs a
browser, so it is a maintainer step rather than part of the website build: the changelog generator
records which cards should exist and reports missing images — failing under `--check` — while the
renderer is what draws them. Point `CHROMIUM` at a browser binary to use one other than Playwright's
bundled build.

The layout is the site's own paper surface. Two content rules shape it: a series with no editorial
summary drops the tagline rather than padding it with the factual fallback (about half of them have
none), and patch chips appear only when a series has more than one release.

## Not built yet

- **Release videos.** The `video` field is implemented end to end, including `VideoObject` schema,
  but no release has a hosted video URL. Host the encoded output rather than committing it; the
  launch-video pipeline keeps generated media out of Git.
- **Contributor lists.** The GitHub release bodies name first-time contributors, which is community
  goodwill and organic links. `CHANGELOG.md` does not carry authors, so this needs a second input.
- **The in-app update notice.** `packages/hunk/src/core/process/updateNotice.ts` tells users a new version exists without
  linking what changed. Appending `hunk.dev/changelog/<minor>` is the highest-intent entry point
  available and is tracked separately.

/**
 * Render the social cards published beside each changelog page.
 *
 * Reads the card content the changelog generator derived into `website/releases/cards.json` and
 * paints each one with Chromium at 1200x630, the OpenGraph canvas. The facts on a card therefore
 * come from the same derivation as the page it belongs to, and this script only decides how they
 * look.
 *
 * Rendering needs a browser, so it is a maintainer task rather than part of the website build:
 * `bun run generate:changelog` records which cards should exist and `--check` reports missing
 * images, while this script is what actually draws them.
 *
 * Usage, from the repository root:
 *   bun run website/scripts/generate-og.ts [slug]...
 *
 * With no arguments every card is redrawn. Point CHROMIUM at a browser binary to use one other
 * than Playwright's bundled build.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(scriptsDir, "..");
const repoRoot = resolve(websiteDir, "..");
const cardsFile = join(websiteDir, "releases", "cards.json");
const outputDir = join(websiteDir, "public", "changelog", "og");
const fontFile = join(
  websiteDir,
  "node_modules",
  "@fontsource-variable",
  "jetbrains-mono",
  "files",
  "jetbrains-mono-latin-wght-normal.woff2",
);

/** Mirrors `SocialCard` in `scripts/generate-changelog.ts`. */
type SocialCard = {
  slug: string;
  title: string;
  tagline?: string;
  meta: string;
  chips?: string[];
  latest?: boolean;
  alt: string;
};

const WIDTH = 1200;
const HEIGHT = 630;

/** Escape text interpolated into the card markup. */
function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Paint one card.
 *
 * The palette and type are the site's own (`website/src/styles/brand.css`), so a card and the page
 * it links to read as one surface. Long titles step down a size rather than wrapping, because a
 * wrapped version number reads as a layout bug.
 */
function renderCardHtml(card: SocialCard, fontDataUri: string) {
  const titleSize = card.title.length > 12 ? 82 : 104;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @font-face {
    font-family: "JetBrains Mono";
    src: url("${fontDataUri}") format("woff2-variations");
    font-weight: 100 800;
    font-display: block;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    background: #f4f1ea;
    color: #16140f;
    font-family: "JetBrains Mono", monospace;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 64px;
  }
  .mark { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .mid { display: flex; flex-direction: column; gap: 22px; }
  .vrow { display: flex; align-items: center; gap: 20px; }
  .title {
    font-size: ${titleSize}px;
    font-weight: 500;
    letter-spacing: -0.045em;
    line-height: 1;
    white-space: nowrap;
  }
  .pill {
    background: #bfe9c6;
    color: #0d3a18;
    font-size: 18px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 7px 15px;
    border-radius: 999px;
  }
  .tagline { font-size: 31px; line-height: 1.4; color: #3a352b; max-width: 900px; }
  .chips { display: flex; gap: 10px; }
  .chip {
    border: 1px solid #dcd6c8;
    background: #fffdf8;
    color: #3a352b;
    font-size: 18px;
    padding: 6px 14px;
    border-radius: 6px;
  }
  .foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 20px;
    color: #6b6557;
    border-top: 1px solid #dcd6c8;
    padding-top: 24px;
  }
</style>
</head>
<body>
  <div class="mark">hunk</div>
  <div class="mid">
    <div class="vrow">
      <span class="title">${escapeHtml(card.title)}</span>
      ${card.latest ? '<span class="pill">Latest</span>' : ""}
    </div>
    ${card.tagline ? `<div class="tagline">${escapeHtml(card.tagline)}</div>` : ""}
    ${
      card.chips?.length
        ? `<div class="chips">${card.chips
            .map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`)
            .join("")}</div>`
        : ""
    }
  </div>
  <div class="foot"><span>${escapeHtml(card.meta)}</span><span>hunk.dev/changelog</span></div>
</body>
</html>`;
}

const requested = new Set(process.argv.slice(2));
const cards = JSON.parse(readFileSync(cardsFile, "utf8")) as SocialCard[];
const selected = requested.size > 0 ? cards.filter((card) => requested.has(card.slug)) : cards;

if (selected.length === 0) {
  const known = cards.map((card) => card.slug).join(", ");
  throw new Error(`No cards matched ${[...requested].join(", ")}. Known slugs: ${known}`);
}

const fontDataUri = `data:font/woff2;base64,${readFileSync(fontFile).toString("base64")}`;
mkdirSync(outputDir, { recursive: true });

// A stale image for a series that no longer exists would keep being served; a full run owns the
// directory, while a targeted run only touches what it was asked for.
if (requested.size === 0) {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
}

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

for (const card of selected) {
  const html = renderCardHtml(card, fontDataUri);
  const scratch = join(outputDir, `.${card.slug}.html`);
  writeFileSync(scratch, html);
  await page.goto(`file://${scratch}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(outputDir, `${card.slug}.png`) });
  rmSync(scratch);
  console.log(`${card.slug}.png`);
}

await browser.close();
console.log(`Rendered ${selected.length} card(s) into ${outputDir.replace(`${repoRoot}/`, "")}.`);

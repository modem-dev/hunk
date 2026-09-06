import { join } from "node:path";
import {
  BUNDLED_SHIKI_THEME_IDS,
  BUNDLED_SHIKI_THEME_BACKGROUNDS,
  type BundledShikiThemeDiffColors,
  type BundledShikiThemeId,
} from "../packages/hunk/src/core/theme/catalog";

/**
 * Regenerates `BUNDLED_SHIKI_THEME_DIFF_COLORS` in
 * `packages/hunk/src/core/theme/catalog.ts` from the bundled Shiki theme JSONs. Run it with
 * `bun run generate:theme-colors`.
 */

type DiffColorSlot = "added" | "removed" | "modified";

/** Token lookup order per slot, most accent-faithful source first. */
const DIFF_COLOR_TOKEN_SOURCES: Record<DiffColorSlot, readonly string[]> = {
  added: [
    "editorGutter.addedBackground",
    "diffEditor.insertedTextBackground",
    "terminal.ansiGreen",
    "gitDecoration.addedResourceForeground",
  ],
  removed: [
    "editorGutter.deletedBackground",
    "diffEditor.removedTextBackground",
    "terminal.ansiRed",
    "gitDecoration.deletedResourceForeground",
  ],
  modified: [
    "editorGutter.modifiedBackground",
    "gitDecoration.modifiedResourceForeground",
    "terminal.ansiBlue",
  ],
};

const BACKGROUND_CLASS_TOKEN = /^(editorGutter|diffEditor)\./;

const MIN_ACCENT_SATURATION = 0.12;
const MIN_BACKGROUND_TOKEN_CONTRAST_DARK = 3;
const MIN_BACKGROUND_TOKEN_CONTRAST_LIGHT = 2.5;

/**
 * Normalizes a VS Code token color to hex, dropping any alpha channel. Returns undefined for values
 * that are not simple hex colors.
 */
export function normalizeTokenColor(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  const match = /^#([0-9a-f]{3,8})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const digits = match[1]!;
  if (digits.length === 3 || digits.length === 4) {
    return `#${digits
      .slice(0, 3)
      .split("")
      .map((digit) => digit + digit)
      .join("")}`;
  }
  if (digits.length === 6 || digits.length === 8) {
    return `#${digits.slice(0, 6)}`;
  }
  return undefined;
}

interface HslColor {
  hue: number;
  saturation: number;
  lightness: number;
}

/** Converts a 6-digit hex color to HSL with hue in degrees. */
function hexToHsl(hex: string): HslColor {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) {
    return { hue: 0, saturation: 0, lightness };
  }
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === red) {
    hue = 60 * (((green - blue) / delta + 6) % 6);
  } else if (max === green) {
    hue = 60 * ((blue - red) / delta + 2);
  } else {
    hue = 60 * ((red - green) / delta + 4);
  }
  return { hue, saturation, lightness };
}

/** WCAG relative luminance of a 6-digit hex color. */
function relativeLuminance(hex: string) {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio between two 6-digit hex colors. */
function contrastRatio(foreground: string, background: string) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const [lighter, darker] = first >= second ? [first, second] : [second, first];
  return (lighter + 0.05) / (darker + 0.05);
}

/** True when a color reads as a green/teal-family accent, the hue class of added lines. */
function isAddedAccentHue(hue: number) {
  return hue >= 50 && hue <= 200;
}

/** True when a color reads as a red/pink-family accent, the hue class of removed lines. */
function isRemovedAccentHue(hue: number) {
  return hue >= 300 || hue <= 30;
}

/** Validates one candidate value for one slot against the accent gates. */
function isUsableAccent(
  slot: DiffColorSlot,
  token: string,
  color: string,
  themeBackground: string,
): boolean {
  const { hue, saturation } = hexToHsl(color);
  if (saturation < MIN_ACCENT_SATURATION) {
    return false;
  }
  if (slot === "added" && !isAddedAccentHue(hue)) {
    return false;
  }
  if (slot === "removed" && !isRemovedAccentHue(hue)) {
    return false;
  }
  if (BACKGROUND_CLASS_TOKEN.test(token)) {
    const isLightSurface = relativeLuminance(themeBackground) > 0.45;
    const minimumContrast = isLightSurface
      ? MIN_BACKGROUND_TOKEN_CONTRAST_LIGHT
      : MIN_BACKGROUND_TOKEN_CONTRAST_DARK;
    if (contrastRatio(color, themeBackground) < minimumContrast) {
      return false;
    }
  }
  return true;
}

/**
 * Harvests one theme's semantic diff accents from its VS Code color tokens. Returns undefined
 * when there are no usable accents, indicating the generic fallback palette should be applied.
 */
export function harvestThemeDiffColors(
  colors: Record<string, string | undefined>,
  themeBackground: string,
): BundledShikiThemeDiffColors | undefined {
  const entry: BundledShikiThemeDiffColors = {};
  for (const slot of ["added", "removed", "modified"] as const) {
    for (const token of DIFF_COLOR_TOKEN_SOURCES[slot]) {
      const raw = colors[token];
      if (!raw) {
        continue;
      }
      const color = normalizeTokenColor(raw);
      if (!color) {
        continue;
      }
      if (isUsableAccent(slot, token, color, themeBackground)) {
        entry[slot] = color;
        break;
      }
    }
  }
  if (!entry.added && !entry.removed) {
    return undefined;
  }
  return entry;
}

/** Loads a bundled theme's color tokens from the pinned `@shikijs/themes` package. */
async function loadThemeColors(themeId: BundledShikiThemeId) {
  const module_ = (await import(`@shikijs/themes/${themeId}`)) as {
    default?: { colors?: Record<string, string> };
  };
  return module_.default?.colors ?? {};
}

/** Harvests every bundled theme into the catalog table shape, in catalog id order. */
export async function harvestBundledThemeDiffColors() {
  const table: Partial<Record<BundledShikiThemeId, BundledShikiThemeDiffColors>> = {};
  for (const themeId of BUNDLED_SHIKI_THEME_IDS) {
    const entry = harvestThemeDiffColors(
      await loadThemeColors(themeId),
      BUNDLED_SHIKI_THEME_BACKGROUNDS[themeId],
    );
    if (entry) {
      table[themeId] = entry;
    }
  }
  return table;
}

const GENERATED_START = "// GENERATED:BUNDLED_SHIKI_THEME_DIFF_COLORS:START";
const GENERATED_END = "// GENERATED:BUNDLED_SHIKI_THEME_DIFF_COLORS:END";

/** Renders the generated table declaration that sits between the catalog markers. */
function renderDiffColorTable(
  table: Partial<Record<BundledShikiThemeId, BundledShikiThemeDiffColors>>,
) {
  const lines = [
    "export const BUNDLED_SHIKI_THEME_DIFF_COLORS: Partial<",
    "  Record<BundledShikiThemeId, BundledShikiThemeDiffColors>",
    "> = {",
  ];
  for (const [themeId, entry] of Object.entries(table)) {
    const key = /^[a-z][a-z0-9]*$/.test(themeId) ? themeId : `"${themeId}"`;
    const slots = (["added", "removed", "modified"] as const)
      .filter((slot) => entry[slot])
      .map((slot) => `${slot}: "${entry[slot]}"`)
      .join(", ");
    lines.push(`  ${key}: { ${slots} },`);
  }
  lines.push("};");
  return lines.join("\n");
}

/** Resolves the Hunk package's checked-in theme catalog from this generator's directory. */
export function resolveThemeCatalogPath(scriptDirectory = import.meta.dir) {
  return join(scriptDirectory, "..", "packages", "hunk", "src", "core", "theme", "catalog.ts");
}

/** Rewrites the generated table region of catalog.ts in place. */
async function writeCatalog(rendered: string) {
  const catalogPath = resolveThemeCatalogPath();
  const source = await Bun.file(catalogPath).text();
  const startIndex = source.indexOf(GENERATED_START);
  const endIndex = source.indexOf(GENERATED_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`catalog.ts is missing the ${GENERATED_START} / ${GENERATED_END} markers`);
  }
  const next =
    source.slice(0, startIndex + GENERATED_START.length) +
    "\n" +
    rendered +
    "\n" +
    source.slice(endIndex);
  await Bun.write(catalogPath, next);
  return catalogPath;
}

if (import.meta.main) {
  const table = await harvestBundledThemeDiffColors();
  const catalogPath = await writeCatalog(renderDiffColorTable(table));
  console.log(`Wrote ${Object.keys(table).length} theme entries to ${catalogPath}`);
}

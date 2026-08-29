import { TRANSPARENT_BACKGROUND, type AppTheme } from "../themes";
import { blendHex, contrastRatio, hexColorDistance } from "../lib/color";
import type { ExtensionLineHighlightTone } from "../../extension-api/types";
import type { SplitLineCell, StackLineCell } from "./diffRows";

const INACTIVE_RAIL_BLEND = 0.35;
const SELECTION_BG_BLEND = 0.75;
const CURSOR_LINE_BG_BLEND = 0.2;
const selectionBackgroundCache = new WeakMap<AppTheme, Map<string, string>>();
const cursorLineBackgroundCache = new WeakMap<AppTheme, Map<string, string>>();

/** Memoize one derived row background per theme and base color. */
function cachedRowBackground(
  cache: WeakMap<AppTheme, Map<string, string>>,
  theme: AppTheme,
  baseBg: string,
  blend: () => string,
) {
  let backgrounds = cache.get(theme);
  if (!backgrounds) {
    backgrounds = new Map();
    cache.set(theme, backgrounds);
  }
  let background = backgrounds.get(baseBg);
  if (background === undefined) {
    background = blend();
    backgrounds.set(baseBg, background);
  }
  return background;
}

/** The diff rail marker is always visible in Hunk stack and split rows. */
export function diffRailMarker() {
  return "▌";
}

/**
 * Blend a base cell background toward the selection highlight color.
 *
 * blendHex(fg, bg, ratio) returns `bg + (fg - bg) * ratio`. We pass the highlight color as the
 * "front" and the cell's base bg as the "back", so a higher SELECTION_BG_BLEND pulls the result
 * harder toward the visible highlight color.
 */
export function selectionHighlightBg(baseBg: string, theme: AppTheme) {
  return cachedRowBackground(selectionBackgroundCache, theme, baseBg, () =>
    blendHex(theme.selectedHunk, baseBg, SELECTION_BG_BLEND),
  );
}

/**
 * Lift a cell background toward the theme text color to mark the current line.
 *
 * Shifts luminance rather than hue: blending toward one fixed color barely moves a background
 * already sharing that hue, which left the marker invisible on added rows.
 */
export function cursorLineHighlightBg(baseBg: string, theme: AppTheme) {
  return cachedRowBackground(cursorLineBackgroundCache, theme, baseBg, () => {
    // Reading the sentinel as a color yields black, so a transparent surface blends from the
    // appearance's own extreme instead.
    const source =
      baseBg === TRANSPARENT_BACKGROUND
        ? theme.appearance === "dark"
          ? "#000000"
          : "#ffffff"
        : baseBg;
    return blendHex(theme.text, source, CURSOR_LINE_BG_BLEND);
  });
}

/** Return the neutral active-hunk rail color for the current theme. */
export function neutralRailColor(theme: AppTheme) {
  return theme.lineNumberFg;
}

/** Dim a rail color for inactive hunks by blending toward the panel background. */
export function dimRailColor(color: string, theme: AppTheme) {
  return blendHex(color, theme.panel, INACTIVE_RAIL_BLEND);
}

/** Pick the stack-view rail color for one rendered row. */
export function stackRailColor(kind: StackLineCell["kind"], theme: AppTheme, selected: boolean) {
  let color: string;

  if (kind === "addition") {
    color = theme.addedSignColor;
  } else if (kind === "deletion") {
    color = theme.removedSignColor;
  } else {
    color = neutralRailColor(theme);
  }

  return selected ? color : dimRailColor(color, theme);
}

/** Pick the left split-view rail color from the old-side cell state. */
export function splitLeftRailColor(
  kind: SplitLineCell["kind"],
  theme: AppTheme,
  selected: boolean,
) {
  const color = kind === "deletion" ? theme.removedSignColor : neutralRailColor(theme);
  return selected ? color : dimRailColor(color, theme);
}

/** Pick the right split-view rail color from the new-side cell state. */
export function splitRightRailColor(
  kind: SplitLineCell["kind"],
  theme: AppTheme,
  selected: boolean,
) {
  const color = kind === "addition" ? theme.addedSignColor : neutralRailColor(theme);
  return selected ? color : dimRailColor(color, theme);
}

/** Pick split-view colors from the semantic diff cell kind. */
export function splitCellPalette(
  kind: SplitLineCell["kind"],
  theme: AppTheme,
  moveKind?: SplitLineCell["moveKind"],
) {
  if (kind === "addition") {
    return {
      gutterBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      contentBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      contentBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  if (kind === "empty") {
    return {
      gutterBg: theme.lineNumberBg,
      contentBg: theme.panelAlt,
      signColor: theme.muted,
      numberColor: theme.lineNumberFg,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

/** Pick stack-view colors from the semantic diff cell kind. */
export function stackCellPalette(
  kind: StackLineCell["kind"],
  theme: AppTheme,
  moveKind?: StackLineCell["moveKind"],
) {
  if (kind === "addition") {
    return {
      gutterBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      contentBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      contentBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

// Word-diff emphasis guarantees 28 (`MIN_EMPHASIS_SEPARATION` in themes.ts),
// but that floor is tuned for subtle tinting inside already-tinted lines.
// Extension marks are things the user is looking *for* — search hits,
// diagnostics — so they target a substantially higher floor: distances are
// summed channel deltas on a 0–765 scale, and 28 reads as a whisper on many
// added/removed backgrounds. The readability guard below may bind first on a
// few theme/tone combinations, which is the intended order of priorities.
const MIN_LINE_HIGHLIGHT_BG_DISTANCE = 72;
const LINE_HIGHLIGHT_BLEND_STEP = 0.05;
const LINE_HIGHLIGHT_MAX_BLEND = 0.85;
// Strengthening stops before the code on top of the mark becomes hard to
// read: a mark that eats its own text would defeat the point of marking it.
const MIN_LINE_HIGHLIGHT_TEXT_CONTRAST = 3.1;

/** How one resolved mark paints: a background, plus a foreground when the mark inverts or dims. */
export type LineHighlightStyle =
  | {
      bg: string;
      /** Set only for reverse-video marks; tinted marks keep the spans' own colors. */
      fg?: string;
      transformFg?: never;
    }
  | {
      bg?: string;
      fg?: string;
      /** Set for marks that transform the span's foreground color (e.g. dimming). */
      transformFg: (sourceFg: string | undefined, spanBg: string | undefined) => string;
    };

const lineHighlightStyleCache = new WeakMap<
  AppTheme,
  Map<string, LineHighlightStyle | undefined>
>();

/** Return whether a theme color can safely participate in RGB distance and blend math. */
function isHexThemeColor(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color);
}

/**
 * Resolve the background a mark actually sits on into blendable hex.
 *
 * A transparent cell shows whatever is behind the terminal, so there is no
 * color to blend against. Fall back to the theme's own background, and then —
 * when that is transparent too, which is the whole point of the transparent
 * surface option — to the appearance's extreme, exactly as the cursor-line
 * marker does. The mark then paints an opaque tint instead of nothing at all.
 */
function effectiveHighlightBackground(baseBg: string, theme: AppTheme) {
  if (isHexThemeColor(baseBg)) return baseBg;
  if (isHexThemeColor(theme.background)) return theme.background;
  return theme.appearance === "dark" ? "#000000" : "#ffffff";
}

/** The theme color one tinted highlight tone pulls the line background toward. */
function lineHighlightToneAnchor(
  tone: Exclude<ExtensionLineHighlightTone, "dim">,
  theme: AppTheme,
) {
  switch (tone) {
    case "info":
      return theme.badgeNeutral;
    case "warning":
      return theme.fileModified;
    case "error":
      return theme.removedSignColor;
    case "current":
    case "match":
      return theme.accent;
  }
}

/**
 * Blend the anchor into the base background until the mark clears its distance
 * floor, backing off before the theme's text stops being readable on it.
 */
function strengthenLineHighlightBg(
  baseBg: string,
  anchor: string,
  minDistance: number,
  textColor: string,
) {
  let strongestReadable = baseBg;
  const maxSteps = Math.floor(LINE_HIGHLIGHT_MAX_BLEND / LINE_HIGHLIGHT_BLEND_STEP);

  for (let step = 1; step <= maxSteps; step += 1) {
    const candidate = blendHex(anchor, baseBg, step * LINE_HIGHLIGHT_BLEND_STEP);
    if (contrastRatio(textColor, candidate) < MIN_LINE_HIGHLIGHT_TEXT_CONTRAST) {
      // Readability wins over the distance floor: return the strongest mark
      // the code on top of it can still be read through.
      return strongestReadable;
    }
    strongestReadable = candidate;
    if (hexColorDistance(candidate, baseBg) >= minDistance) {
      return candidate;
    }
  }

  return strongestReadable;
}

/**
 * Resolve one extension highlight tone against the background it will sit on.
 *
 * Visibility is the host's guarantee, not the extension's problem. Tinted
 * tones blend the anchor color into the line's own background until the
 * result clears a minimum perceptual distance — backing off before the code
 * on top stops being readable — so a mark reads on added, removed, and
 * context lines alike. `"current"` inverts instead: theme text as the
 * background, theme background as the foreground — the reverse-video
 * convention `less` and vim use for the active hit, unmistakable and readable
 * by construction. A transparent cell has no color to blend against, so
 * resolution falls back to the background the terminal effectively shows
 * rather than painting nothing — the tint is then chosen against an assumed
 * surface, not the real one. Returns `undefined` — leave the spans untouched —
 * only when the theme's own colors cannot take a blend at all, the same
 * degradation word-diff emphasis uses.
 */
export function lineHighlightToneStyle(
  tone: "dim",
  baseBg: string,
  theme: AppTheme,
): Extract<LineHighlightStyle, { transformFg: unknown }> | undefined;
export function lineHighlightToneStyle(
  tone: Exclude<ExtensionLineHighlightTone, "dim">,
  baseBg: string,
  theme: AppTheme,
): Extract<LineHighlightStyle, { bg: string }> | undefined;
export function lineHighlightToneStyle(
  tone: ExtensionLineHighlightTone,
  baseBg: string,
  theme: AppTheme,
): LineHighlightStyle | undefined;
export function lineHighlightToneStyle(
  tone: ExtensionLineHighlightTone,
  baseBg: string,
  theme: AppTheme,
): LineHighlightStyle | undefined {
  let styles = lineHighlightStyleCache.get(theme);
  if (!styles) {
    styles = new Map();
    lineHighlightStyleCache.set(theme, styles);
  }
  const cacheKey = `${tone}:${baseBg}`;
  if (styles.has(cacheKey)) {
    return styles.get(cacheKey);
  }

  const resolved = resolveLineHighlightToneStyle(tone, baseBg, theme);
  styles.set(cacheKey, resolved);
  return resolved;
}

const DEFAULT_DIM_RATIO = 0.45;
const MIN_DIM_TEXT_CONTRAST = 1.6;

const dimSpanFgCache = new WeakMap<AppTheme, Map<string, string>>();

/** Dim a span's foreground color toward its effective background while preserving hue. */
export function dimSpanFg(
  sourceFg: string | undefined,
  baseBg: string,
  theme: AppTheme,
  ratio = DEFAULT_DIM_RATIO,
): string {
  let themeCache = dimSpanFgCache.get(theme);
  if (!themeCache) {
    themeCache = new Map();
    dimSpanFgCache.set(theme, themeCache);
  }
  const cacheKey = `${baseBg}:${sourceFg ?? ""}:${ratio}`;
  const cached = themeCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const effectiveBg = effectiveHighlightBackground(baseBg, theme);
  const fallbackFg = theme.syntaxColors.default || theme.text;
  const effectiveFg =
    sourceFg && isHexThemeColor(sourceFg)
      ? sourceFg
      : isHexThemeColor(fallbackFg)
        ? fallbackFg
        : theme.appearance === "dark"
          ? "#adbac7"
          : "#24292f";

  let result = effectiveFg;
  const candidate = blendHex(effectiveFg, effectiveBg, ratio);
  if (contrastRatio(candidate, effectiveBg) >= MIN_DIM_TEXT_CONTRAST) {
    result = candidate;
  } else {
    for (let step = 1; step <= 9; step += 1) {
      const stepRatio = ratio + step * 0.05;
      if (stepRatio > 0.901) break;
      const strengthened = blendHex(effectiveFg, effectiveBg, stepRatio);
      if (contrastRatio(strengthened, effectiveBg) >= MIN_DIM_TEXT_CONTRAST) {
        result = strengthened;
        break;
      }
    }
  }

  themeCache.set(cacheKey, result);
  return result;
}

/** Compute one uncached tone style; `lineHighlightToneStyle` owns memoization. */
function resolveLineHighlightToneStyle(
  tone: ExtensionLineHighlightTone,
  baseBg: string,
  theme: AppTheme,
): LineHighlightStyle | undefined {
  if (tone === "dim") {
    return {
      transformFg: (sourceFg, spanBg) => dimSpanFg(sourceFg, spanBg ?? baseBg, theme),
    };
  }

  if (tone === "current" && isHexThemeColor(theme.text)) {
    return { bg: theme.text, fg: effectiveHighlightBackground(theme.background, theme) };
  }

  const anchor = lineHighlightToneAnchor(tone, theme);
  if (!isHexThemeColor(anchor) || !isHexThemeColor(theme.text)) {
    return undefined;
  }

  return {
    bg: strengthenLineHighlightBg(
      effectiveHighlightBackground(baseBg, theme),
      anchor,
      MIN_LINE_HIGHLIGHT_BG_DISTANCE,
      theme.text,
    ),
  };
}

/** Format one optional line number for a fixed-width diff gutter. */
export function diffLineNumberText(value: number | undefined, width: number) {
  return value === undefined ? " ".repeat(width) : String(value).padStart(width, " ");
}

/** Build the stack-view gutter text shared by the TUI and static pager renderers. */
export function stackGutterText(
  cell: StackLineCell,
  lineNumberDigits: number,
  showLineNumbers: boolean,
) {
  if (!showLineNumbers) {
    return `${cell.sign} `;
  }

  const oldNumber = diffLineNumberText(cell.oldLineNumber, lineNumberDigits);
  const newNumber = diffLineNumberText(cell.newLineNumber, lineNumberDigits);
  return `${oldNumber} ${newNumber} ${cell.sign}`;
}

/** Build the split-view gutter text shared by the TUI and clipboard renderers. */
export function splitGutterText(
  cell: SplitLineCell,
  lineNumberDigits: number,
  showLineNumbers: boolean,
) {
  if (!showLineNumbers) {
    return `${cell.sign} `;
  }

  const number = cell.lineNumber
    ? String(cell.lineNumber).padStart(lineNumberDigits, " ")
    : " ".repeat(lineNumberDigits);
  return `${number} ${cell.sign}`;
}

import { TRANSPARENT_BACKGROUND, type AppTheme } from "../themes";
import { blendHex, hexColorDistance } from "../lib/color";
import type { ExtensionLineHighlightTone } from "../../extension-api/types";
import type { SplitLineCell, StackLineCell } from "./pierre";

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

// The same minimum perceptual distance Pierre word-diff emphasis guarantees
// (`MIN_WORD_DIFF_BG_DISTANCE` in pierre.ts): below it a background is
// indistinguishable from the line it sits on — the exact failure this API
// exists to prevent.
const MIN_LINE_HIGHLIGHT_BG_DISTANCE = 28;
// `current` is the emphatic variant of `match`; a higher distance floor keeps
// the active mark visibly distinct from its siblings on every line kind.
const MIN_CURRENT_HIGHLIGHT_BG_DISTANCE = 64;
const LINE_HIGHLIGHT_BLEND_STEP = 0.05;
const LINE_HIGHLIGHT_MAX_BLEND = 0.85;

const lineHighlightBackgroundCache = new WeakMap<AppTheme, Map<string, string | undefined>>();

/** Return whether a theme color can safely participate in RGB distance and blend math. */
function isHexThemeColor(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color);
}

/** The theme color one highlight tone pulls the line background toward. */
function lineHighlightToneAnchor(tone: ExtensionLineHighlightTone, theme: AppTheme) {
  switch (tone) {
    case "current":
      // Luminance rather than hue, like the cursor line: blending toward one
      // accent barely moves a background already sharing its hue.
      return theme.text;
    case "info":
      return theme.badgeNeutral;
    case "warning":
      return theme.fileModified;
    case "error":
      return theme.removedSignColor;
    case "match":
      return theme.accent;
  }
}

/** Blend the anchor into the base background until the mark clears its distance floor. */
function strengthenLineHighlightBg(baseBg: string, anchor: string, minDistance: number) {
  let strongestCandidate = baseBg;
  const maxSteps = Math.floor(LINE_HIGHLIGHT_MAX_BLEND / LINE_HIGHLIGHT_BLEND_STEP);

  for (let step = 1; step <= maxSteps; step += 1) {
    const candidate = blendHex(anchor, baseBg, step * LINE_HIGHLIGHT_BLEND_STEP);
    strongestCandidate = candidate;
    if (hexColorDistance(candidate, baseBg) >= minDistance) {
      return candidate;
    }
  }

  return strongestCandidate;
}

/**
 * Resolve one extension highlight tone against the background it will sit on.
 *
 * Visibility is the host's guarantee, not the extension's problem: the anchor
 * color is blended into the line's own background until the result clears a
 * minimum perceptual distance, so a mark reads on added, removed, and context
 * lines alike. Returns `undefined` — leave the background untouched — for
 * surfaces that cannot take a blend (transparent or non-hex theme colors),
 * the same degradation word-diff emphasis uses.
 */
export function lineHighlightToneBg(
  tone: ExtensionLineHighlightTone,
  baseBg: string,
  theme: AppTheme,
): string | undefined {
  let backgrounds = lineHighlightBackgroundCache.get(theme);
  if (!backgrounds) {
    backgrounds = new Map();
    lineHighlightBackgroundCache.set(theme, backgrounds);
  }
  const cacheKey = `${tone}:${baseBg}`;
  if (backgrounds.has(cacheKey)) {
    return backgrounds.get(cacheKey);
  }

  const anchor = lineHighlightToneAnchor(tone, theme);
  const resolved =
    baseBg === TRANSPARENT_BACKGROUND || !isHexThemeColor(baseBg) || !isHexThemeColor(anchor)
      ? undefined
      : strengthenLineHighlightBg(
          baseBg,
          anchor,
          tone === "current" ? MIN_CURRENT_HIGHLIGHT_BG_DISTANCE : MIN_LINE_HIGHLIGHT_BG_DISTANCE,
        );
  backgrounds.set(cacheKey, resolved);
  return resolved;
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

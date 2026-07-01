import type { AppTheme } from "../themes";
import { blendHex } from "../lib/color";
import type { SplitLineCell, StackLineCell } from "./pierre";

const INACTIVE_RAIL_BLEND = 0.35;
const SELECTION_BG_BLEND = 0.75;

/** The diff rail marker is always visible in Hunk stack and split rows. */
export function diffRailMarker() {
  return "▌";
}

/**
 * Glyph tiled across a split-view cell that has no equivalent line on this side.
 *
 * The light diagonal (U+2572, upper-left to lower-right) tiles into continuous diagonal lines,
 * reading as a "nothing here" hatch rather than as code. We use this direction over U+2571 so a
 * row of hatch does not resemble a leading `//` comment. Rendered instead of a flat filler block so
 * absent regions stay legible without a heavy grey background.
 */
export const EMPTY_CELL_HATCH_GLYPH = "╲";

/** Dim foreground for the empty-cell diagonal hatch, kept subtle against the panel background. */
export function emptyHatchColor(theme: AppTheme) {
  return blendHex(theme.lineNumberFg, theme.background, 0.55);
}

/**
 * Faint background tint behind the empty-cell hatch.
 *
 * A subtle muted wash under the diagonal lines reads as a faded/disabled region without the heavy
 * grey filler block. Kept lighter than {@link AppTheme.panelAlt} so the hatch, not the fill, carries
 * the "absent" cue.
 */
export function emptyHatchBg(theme: AppTheme) {
  return blendHex(theme.lineNumberFg, theme.background, 0.1);
}

/**
 * Blend a base cell background toward the selection highlight color.
 *
 * blendHex(fg, bg, ratio) returns `bg + (fg - bg) * ratio`. We pass the highlight color as the
 * "front" and the cell's base bg as the "back", so a higher SELECTION_BG_BLEND pulls the result
 * harder toward the visible highlight color.
 */
export function selectionHighlightBg(baseBg: string, theme: AppTheme) {
  return blendHex(theme.selectedHunk, baseBg, SELECTION_BG_BLEND);
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
    // The cell renders a diagonal hatch over a faint muted wash (not a flat grey filler block),
    // so the gutter and content share the subtle "faded/disabled" background.
    return {
      gutterBg: emptyHatchBg(theme),
      contentBg: emptyHatchBg(theme),
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

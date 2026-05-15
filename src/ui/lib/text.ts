/** Return whether a Unicode code point has zero visible terminal width. */
function isZeroWidthCodePoint(codePoint: number) {
  return (
    codePoint === 0 ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0xfeff ||
    (codePoint >= 0x0001 && codePoint <= 0x001f) ||
    (codePoint >= 0x007f && codePoint <= 0x009f) ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

/** Return whether a Unicode code point normally occupies two terminal cells. */
function isWideCodePoint(codePoint: number) {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

/** Measure one Unicode code point in terminal cells. */
function codePointCellWidth(codePoint: number) {
  if (isZeroWidthCodePoint(codePoint)) {
    return 0;
  }

  return isWideCodePoint(codePoint) ? 2 : 1;
}

/** Measure rendered text in terminal cells, counting CJK/fullwidth characters as two cells. */
export function terminalCellWidth(text: string) {
  let width = 0;

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }

    width += codePointCellWidth(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }

  return width;
}

/** Slice text to a visible terminal-cell window without splitting fullwidth characters. */
export function sliceTextByTerminalCells(text: string, offset: number, width: number) {
  if (width <= 0) {
    return { clipped: terminalCellWidth(text) > Math.max(0, offset), text: "", width: 0 };
  }

  const windowStart = Math.max(0, offset);
  const windowEnd = windowStart + width;
  let cellCursor = 0;
  let output = "";
  let usedWidth = 0;
  let clipped = false;
  let includedPreviousVisibleCodePoint = false;

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }

    const char = String.fromCodePoint(codePoint);
    const charWidth = codePointCellWidth(codePoint);
    const nextCellCursor = cellCursor + charWidth;
    index += codePoint > 0xffff ? 2 : 1;

    if (charWidth === 0) {
      if (
        includedPreviousVisibleCodePoint ||
        (output.length > 0 && cellCursor >= windowStart && cellCursor <= windowEnd)
      ) {
        output += char;
      }
      continue;
    }

    if (nextCellCursor <= windowStart) {
      cellCursor = nextCellCursor;
      includedPreviousVisibleCodePoint = false;
      continue;
    }

    // If the requested window starts in the middle of a fullwidth glyph, omit that glyph entirely.
    if (cellCursor < windowStart) {
      const hiddenCellWidth = Math.min(nextCellCursor, windowEnd) - windowStart;
      if (hiddenCellWidth > 0) {
        output += " ".repeat(hiddenCellWidth);
        usedWidth += hiddenCellWidth;
      }

      cellCursor = nextCellCursor;
      includedPreviousVisibleCodePoint = false;
      continue;
    }

    if (cellCursor >= windowEnd || nextCellCursor > windowEnd) {
      clipped = true;
      break;
    }

    output += char;
    usedWidth += charWidth;
    cellCursor = nextCellCursor;
    includedPreviousVisibleCodePoint = true;
  }

  return { clipped, text: output, width: usedWidth };
}

/** Clamp text to a fixed width using a plain-dot terminal fallback marker. */
export function fitText(text: string, width: number) {
  if (width <= 0) {
    return "";
  }

  if (terminalCellWidth(text) <= width) {
    return text;
  }

  if (width === 1) {
    return ".";
  }

  return `${sliceTextByTerminalCells(text, 0, width - 1).text}.`;
}

/** Clamp and then right-pad text to an exact width. */
export function padText(text: string, width: number) {
  const trimmed = fitText(text, width);
  return `${trimmed}${" ".repeat(Math.max(0, width - terminalCellWidth(trimmed)))}`;
}

import stringWidth from "string-width";
import { sanitizeTerminalLine } from "../../lib/terminalText";

const printableAsciiRegex = /^[\u0020-\u007E]*$/;
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Iterate user-visible text clusters so wide and combining characters stay together. */
function textClusters(text: string) {
  if (!graphemeSegmenter) {
    return Array.from(text);
  }

  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

// Measured terminal-cell widths for single non-ASCII characters. Hunk re-measures the same
// chrome glyphs ("─", "▌", "│", ...) constantly, and string-width's grapheme/emoji regexes make
// each cold measure expensive, so cache per-character widths once.
const singleCharWidthCache = new Map<string, number>();

/**
 * Return the single UTF-16 code unit repeated across `text`, or null when text mixes characters.
 * Surrogate halves are rejected because they pair into multi-unit clusters (emoji, rare CJK).
 */
function repeatedSingleUnitChar(text: string): string | null {
  if (text.length < 2) {
    return null;
  }

  const unit = text.charCodeAt(0);
  if (unit >= 0xd800 && unit <= 0xdfff) {
    return null;
  }

  for (let index = 1; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== unit) {
      return null;
    }
  }

  return text[0] ?? null;
}

/** Measure one character through string-width, memoized for repeat lookups. */
function cachedSingleCharWidth(char: string): number {
  let width = singleCharWidthCache.get(char);
  if (width === undefined) {
    width = stringWidth(char);
    singleCharWidthCache.set(char, width);
  }
  return width;
}

function measureSanitizedTextWidth(text: string) {
  if (printableAsciiRegex.test(text)) {
    return text.length;
  }

  // Fast path for chrome glyph runs like "─".repeat(separatorWidth): string-width costs
  // milliseconds for long non-ASCII runs, but a run of one repeated non-combining character is
  // always run-length × single-character width. Each repeated unit with a non-zero width is its
  // own grapheme cluster, so the multiplication is exact.
  const repeatedChar = repeatedSingleUnitChar(text);
  if (repeatedChar !== null) {
    const charWidth = cachedSingleCharWidth(repeatedChar);
    // Zero-width units (combining marks) can merge with neighbors; defer to string-width.
    if (charWidth > 0) {
      return charWidth * text.length;
    }
  }

  return stringWidth(text);
}

/** Measure text in terminal cells, treating CJK and emoji clusters as wide. */
export function measureTextWidth(text: string) {
  return measureSanitizedTextWidth(sanitizeTerminalLine(text));
}

/** Slice text by terminal cells without splitting wide or combining clusters. */
export function sliceTextByWidth(text: string, offset: number, width: number) {
  const safeText = sanitizeTerminalLine(text);
  const startOffset = Math.max(0, offset);
  const maxWidth = Math.max(0, width);
  if (maxWidth === 0) {
    return { text: "", width: 0 };
  }

  if (printableAsciiRegex.test(safeText)) {
    const sliced = safeText.slice(startOffset, startOffset + maxWidth);
    return { text: sliced, width: sliced.length };
  }

  let cursor = 0;
  let usedWidth = 0;
  let visibleText = "";

  for (const cluster of textClusters(safeText)) {
    const clusterWidth = measureSanitizedTextWidth(cluster);
    const clusterStart = cursor;
    const clusterEnd = cursor + clusterWidth;
    cursor = clusterEnd;

    if (clusterEnd <= startOffset) {
      continue;
    }
    if (clusterStart < startOffset) {
      const hiddenCellWidth = Math.min(clusterEnd, startOffset + maxWidth) - startOffset;
      if (hiddenCellWidth > 0) {
        visibleText += " ".repeat(hiddenCellWidth);
        usedWidth += hiddenCellWidth;
      }
      continue;
    }
    if (usedWidth + clusterWidth > maxWidth) {
      break;
    }

    visibleText += cluster;
    usedWidth += clusterWidth;
  }

  return { text: visibleText, width: usedWidth };
}

/**
 * Convert an inclusive terminal-cell range into string slice bounds (`endIndex` exclusive).
 *
 * Mouse selection coordinates are terminal cells while `String#slice` counts UTF-16 code units,
 * and the two drift apart on non-ASCII lines: a full-width CJK character is one code unit but
 * two cells, and an emoji cluster can be many code units but two cells. Clusters only partially
 * covered by the cell range are included in full so a selection can never split a wide
 * character, and zero-width clusters at the range start are kept so invisible characters
 * round-trip through the clipboard. Indices refer to `text` as given; callers pass rendered
 * lines that are already sanitized (sanitizing here could shift the returned indices off the
 * caller's string). Callers must pass a normalized range (`startCell <= endCell`); inverted
 * ranges are unspecified.
 */
export function cellRangeToCharRange(text: string, startCell: number, endCell: number) {
  const safeStartCell = Math.max(0, startCell);

  if (printableAsciiRegex.test(text)) {
    const startIndex = Math.min(text.length, safeStartCell);
    return {
      startIndex,
      endIndex: Math.min(text.length, Math.max(startIndex, endCell + 1)),
    };
  }

  let cellCursor = 0;
  let unitCursor = 0;
  let startIndex = -1;
  let endIndex = text.length;

  for (const cluster of textClusters(text)) {
    // The current cluster starts past the end cell, so everything before it is the slice end.
    if (cellCursor > endCell) {
      endIndex = unitCursor;
      break;
    }

    const clusterWidth = measureSanitizedTextWidth(cluster);
    // Zero-width clusters (e.g. U+200B) occupy no cell, so they never satisfy the covering
    // check; attach them to a range that starts at their position instead of dropping them.
    const coversStart =
      clusterWidth > 0 ? cellCursor + clusterWidth > safeStartCell : cellCursor >= safeStartCell;
    if (startIndex < 0 && coversStart) {
      startIndex = unitCursor;
    }

    cellCursor += clusterWidth;
    unitCursor += cluster.length;
  }

  // A range starting past the end of the line resolves to an empty slice at the text end.
  if (startIndex < 0) {
    startIndex = text.length;
  }

  return { startIndex, endIndex: Math.max(startIndex, endIndex) };
}

/** Clamp text to a fixed width using a plain-dot terminal fallback marker. */
export function fitText(text: string, width: number) {
  const safeText = sanitizeTerminalLine(text);
  if (width <= 0) {
    return "";
  }

  if (measureTextWidth(safeText) <= width) {
    return safeText;
  }

  if (width === 1) {
    return ".";
  }

  return `${sliceTextByWidth(safeText, 0, width - 1).text}.`;
}

/** Clamp and then right-pad text to an exact width. */
export function padText(text: string, width: number) {
  const trimmed = fitText(text, width);
  return `${trimmed}${" ".repeat(Math.max(0, width - measureTextWidth(trimmed)))}`;
}

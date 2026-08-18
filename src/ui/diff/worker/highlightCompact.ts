import { collectHastHighlightRuns, type HastNode } from "./highlightHast";

/** HAST lines for one diff side; `undefined` marks lines the highlighter skipped. */
export type HighlightedHastLines = Array<HastNode | undefined>;

/** Identifies the typed-array layout used for worker highlight responses. */
export const COMPACT_HIGHLIGHT_PROTOCOL_VERSION = 1;

/** Marks one run whose background comes from the receiving row's word-diff policy. */
export const COMPACT_HIGHLIGHT_FLAG_WORD_DIFF = 1;

/** Holds all numeric syntax runs for one diff side. */
export interface CompactHighlightSide {
  /** Maps each line index to its half-open run range in the three run arrays. */
  lineOffsets: Uint32Array;
  /** UTF-16 source-column start for each run. */
  starts: Uint32Array;
  /** UTF-16 source-column end for each run. */
  ends: Uint32Array;
  /** One-based foreground color palette ID; zero means inherit the terminal default. */
  styleIds: Uint16Array;
  /** Bit flags such as `COMPACT_HIGHLIGHT_FLAG_WORD_DIFF`. */
  flags: Uint8Array;
}

/** Carries a text-free, transferable projection of Pierre's highlighted diff output. */
export interface CompactHighlightedDiff {
  version: typeof COMPACT_HIGHLIGHT_PROTOCOL_VERSION;
  /** Deduplicated resolved syntax foreground colors. */
  foregroundPalette: string[];
  deletion: CompactHighlightSide;
  addition: CompactHighlightSide;
}

/** Exposes one decoded range without reconstructing a HAST node or text string. */
export interface CompactHighlightRun {
  start: number;
  end: number;
  fg?: string;
  wordDiff: boolean;
}

interface MutableCompactHighlightSide {
  lineOffsets: number[];
  starts: number[];
  ends: number[];
  styleIds: number[];
  flags: number[];
}

/** Build mutable side arrays before freezing them into transfer-friendly typed arrays. */
function createMutableSide(): MutableCompactHighlightSide {
  return {
    lineOffsets: [0],
    starts: [],
    ends: [],
    styleIds: [],
    flags: [],
  };
}

/** Assign one compact palette ID while preserving first-seen HAST traversal order. */
function compactPaletteId(
  foreground: string | undefined,
  foregroundPalette: string[],
  paletteIds: Map<string, number>,
) {
  if (!foreground) {
    return 0;
  }

  const existingId = paletteIds.get(foreground);
  if (existingId !== undefined) {
    return existingId;
  }
  if (foregroundPalette.length === 0xffff) {
    throw new Error("Compact syntax palette exceeded Uint16 style IDs.");
  }

  foregroundPalette.push(foreground);
  const styleId = foregroundPalette.length;
  paletteIds.set(foreground, styleId);
  return styleId;
}

/** Encode one side's HAST lines in one traversal without retaining token text in the result. */
function encodeSide({
  lines,
  appearance,
  foregroundPalette,
  paletteIds,
}: {
  lines: HighlightedHastLines;
  appearance: "dark" | "light";
  foregroundPalette: string[];
  paletteIds: Map<string, number>;
}) {
  const side = createMutableSide();

  for (const line of lines) {
    let sourceColumn = 0;
    for (const run of collectHastHighlightRuns(line, appearance)) {
      const start = sourceColumn;
      sourceColumn += run.text.length;
      const end = sourceColumn;
      if (end === start) {
        continue;
      }

      const styleId = compactPaletteId(run.fg, foregroundPalette, paletteIds);

      side.starts.push(start);
      side.ends.push(end);
      side.styleIds.push(styleId);
      side.flags.push(run.wordDiff ? COMPACT_HIGHLIGHT_FLAG_WORD_DIFF : 0);
    }
    side.lineOffsets.push(side.starts.length);
  }

  return {
    lineOffsets: Uint32Array.from(side.lineOffsets),
    starts: Uint32Array.from(side.starts),
    ends: Uint32Array.from(side.ends),
    styleIds: Uint16Array.from(side.styleIds),
    flags: Uint8Array.from(side.flags),
  } satisfies CompactHighlightSide;
}

/**
 * Converts Pierre HAST into a text-free worker response.
 *
 * The receiving terminal retains the original diff text and reconstructs terminal spans from the
 * numeric ranges. Colors deliberately remain palette values while word-diff background stays a
 * semantic flag so each row can apply its existing theme policy.
 */
export function encodeCompactHighlightedDiff(
  code: { deletionLines: HighlightedHastLines; additionLines: HighlightedHastLines },
  appearance: "dark" | "light",
): CompactHighlightedDiff {
  const foregroundPalette: string[] = [];
  const paletteIds = new Map<string, number>();

  return {
    version: COMPACT_HIGHLIGHT_PROTOCOL_VERSION,
    foregroundPalette,
    deletion: encodeSide({
      lines: code.deletionLines,
      appearance,
      foregroundPalette,
      paletteIds,
    }),
    addition: encodeSide({
      lines: code.additionLines,
      appearance,
      foregroundPalette,
      paletteIds,
    }),
  };
}

/** Return one side's typed-array buffers for a zero-copy worker response transfer. */
function sideTransferList(side: CompactHighlightSide) {
  return [
    side.lineOffsets.buffer,
    side.starts.buffer,
    side.ends.buffer,
    side.styleIds.buffer,
    side.flags.buffer,
  ];
}

/** Return the transferable buffers that contain every numeric compact response field. */
export function compactHighlightTransferList(payload: CompactHighlightedDiff) {
  return [...sideTransferList(payload.deletion), ...sideTransferList(payload.addition)];
}

/** Clone one payload before transferring it so a worker-owned cache keeps its buffers. */
export function cloneCompactHighlightedDiff(
  payload: CompactHighlightedDiff,
): CompactHighlightedDiff {
  const cloneSide = (side: CompactHighlightSide): CompactHighlightSide => ({
    lineOffsets: side.lineOffsets.slice(),
    starts: side.starts.slice(),
    ends: side.ends.slice(),
    styleIds: side.styleIds.slice(),
    flags: side.flags.slice(),
  });

  return {
    version: payload.version,
    foregroundPalette: [...payload.foregroundPalette],
    deletion: cloneSide(payload.deletion),
    addition: cloneSide(payload.addition),
  };
}

/** Estimate the retained wire size, including the small cloned color palette. */
export function compactHighlightedDiffByteLength(payload: CompactHighlightedDiff) {
  const numericBytes = compactHighlightTransferList(payload).reduce(
    (total, buffer) => total + buffer.byteLength,
    0,
  );
  const paletteBytes = new TextEncoder().encode(
    JSON.stringify(payload.foregroundPalette),
  ).byteLength;
  return numericBytes + paletteBytes;
}

/** Validate one compact side before it enters a cache or renderer. */
function validateSide({
  side,
  paletteLength,
  lineLengths,
  name,
}: {
  side: CompactHighlightSide;
  paletteLength: number;
  lineLengths?: readonly number[];
  name: string;
}) {
  if (
    !(side.lineOffsets instanceof Uint32Array) ||
    !(side.starts instanceof Uint32Array) ||
    !(side.ends instanceof Uint32Array) ||
    !(side.styleIds instanceof Uint16Array) ||
    !(side.flags instanceof Uint8Array)
  ) {
    throw new Error(`Compact ${name} highlight fields must be typed arrays.`);
  }

  const runCount = side.starts.length;
  if (
    side.ends.length !== runCount ||
    side.styleIds.length !== runCount ||
    side.flags.length !== runCount ||
    side.lineOffsets.length === 0
  ) {
    throw new Error(`Compact ${name} highlight run arrays disagree.`);
  }
  if (lineLengths && lineLengths.length !== side.lineOffsets.length - 1) {
    throw new Error(`Compact ${name} highlight line count does not match its source.`);
  }

  let previousOffset = 0;
  for (let lineIndex = 0; lineIndex < side.lineOffsets.length; lineIndex += 1) {
    const offset = side.lineOffsets[lineIndex]!;
    if (offset < previousOffset || offset > runCount) {
      throw new Error(`Compact ${name} highlight offsets are invalid.`);
    }
    previousOffset = offset;
  }
  if (previousOffset !== runCount) {
    throw new Error(`Compact ${name} highlight final offset does not reach its runs.`);
  }

  for (let lineIndex = 0; lineIndex < side.lineOffsets.length - 1; lineIndex += 1) {
    const startOffset = side.lineOffsets[lineIndex]!;
    const endOffset = side.lineOffsets[lineIndex + 1]!;
    let previousEnd = 0;
    const lineLength = lineLengths?.[lineIndex];

    for (let runIndex = startOffset; runIndex < endOffset; runIndex += 1) {
      const start = side.starts[runIndex]!;
      const end = side.ends[runIndex]!;
      const styleId = side.styleIds[runIndex]!;
      const flags = side.flags[runIndex]!;
      if (start !== previousEnd || end <= start || (lineLength !== undefined && end > lineLength)) {
        throw new Error(`Compact ${name} highlight ranges are invalid at line ${lineIndex}.`);
      }
      if (styleId > paletteLength) {
        throw new Error(`Compact ${name} highlight style ID is outside its palette.`);
      }
      if ((flags & ~COMPACT_HIGHLIGHT_FLAG_WORD_DIFF) !== 0) {
        throw new Error(`Compact ${name} highlight contains unsupported flags.`);
      }
      previousEnd = end;
    }

    if (startOffset < endOffset && lineLength !== undefined && previousEnd !== lineLength) {
      throw new Error(`Compact ${name} highlight ranges do not cover line ${lineIndex}.`);
    }
  }
}

/** Validate a received compact payload before it is cached or decoded. */
export function validateCompactHighlightedDiff(
  payload: CompactHighlightedDiff,
  lineLengths?: {
    deletion: readonly number[];
    addition: readonly number[];
  },
) {
  if (payload.version !== COMPACT_HIGHLIGHT_PROTOCOL_VERSION) {
    throw new Error(`Unsupported compact highlight protocol version: ${String(payload.version)}`);
  }
  if (
    !Array.isArray(payload.foregroundPalette) ||
    payload.foregroundPalette.some((color) => typeof color !== "string" || color.length === 0)
  ) {
    throw new Error("Compact syntax palette contains an invalid color.");
  }

  validateSide({
    side: payload.deletion,
    paletteLength: payload.foregroundPalette.length,
    lineLengths: lineLengths?.deletion,
    name: "deletion",
  });
  validateSide({
    side: payload.addition,
    paletteLength: payload.foregroundPalette.length,
    lineLengths: lineLengths?.addition,
    name: "addition",
  });
}

/** Read one compact line's styles without rebuilding HAST nodes or token text. */
export function compactHighlightRunsForLine(
  payload: CompactHighlightedDiff,
  sideName: "deletion" | "addition",
  lineIndex: number,
): CompactHighlightRun[] {
  const side = payload[sideName];
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= side.lineOffsets.length - 1) {
    throw new Error(`Compact ${sideName} highlight line index is outside its payload.`);
  }

  const startOffset = side.lineOffsets[lineIndex]!;
  const endOffset = side.lineOffsets[lineIndex + 1]!;
  const runs: CompactHighlightRun[] = [];
  for (let runIndex = startOffset; runIndex < endOffset; runIndex += 1) {
    const styleId = side.styleIds[runIndex]!;
    runs.push({
      start: side.starts[runIndex]!,
      end: side.ends[runIndex]!,
      fg: styleId === 0 ? undefined : payload.foregroundPalette[styleId - 1],
      wordDiff: (side.flags[runIndex]! & COMPACT_HIGHLIGHT_FLAG_WORD_DIFF) !== 0,
    });
  }
  return runs;
}

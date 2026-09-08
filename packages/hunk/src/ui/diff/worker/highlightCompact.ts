import { collectHastHighlightRuns, type HastNode } from "./highlightHast";

/** Matches the CSS hex forms OpenTUI's `parseColor` accepts for syntax token paint. */
const COMPACT_PALETTE_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** HAST lines for one diff side; `undefined` marks lines the highlighter skipped. */
export type HighlightedHastLines = Array<HastNode | undefined>;

/** Identifies the typed-array layout used for worker highlight responses. */
export const COMPACT_HIGHLIGHT_PROTOCOL_VERSION = 1;

/** Marks one run whose background comes from the receiving row's word-diff policy. */
export const COMPACT_HIGHLIGHT_FLAG_WORD_DIFF = 1;

/** Holds all numeric syntax runs for one document or diff side. */
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

/** Carries a text-free, transferable projection of one highlighted document. */
export interface CompactHighlightedDocument {
  version: typeof COMPACT_HIGHLIGHT_PROTOCOL_VERSION;
  /** Deduplicated resolved syntax foreground colors. */
  foregroundPalette: string[];
  /** Numeric UTF-16 runs grouped by zero-based source line. */
  document: CompactHighlightSide;
}

/** Carries a text-free, transferable projection of Pierre's highlighted diff output. */
export interface CompactHighlightedDiff {
  version: typeof COMPACT_HIGHLIGHT_PROTOCOL_VERSION;
  /** Deduplicated resolved syntax foreground colors. */
  foregroundPalette: string[];
  deletion: CompactHighlightSide;
  addition: CompactHighlightSide;
}

/** Exposes one decoded syntax range without reconstructing a HAST node or text string. */
export interface CompactDocumentHighlightRun {
  start: number;
  end: number;
  fg?: string;
}

/** Exposes one decoded diff range, including the diff-only word emphasis policy. */
export interface CompactHighlightRun extends CompactDocumentHighlightRun {
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
  if (!COMPACT_PALETTE_COLOR_PATTERN.test(foreground)) {
    throw new Error("Compact syntax palette contains an invalid color.");
  }
  const normalizedForeground = foreground.toLowerCase();

  const existingId = paletteIds.get(normalizedForeground);
  if (existingId !== undefined) {
    return existingId;
  }
  if (foregroundPalette.length === 0xffff) {
    throw new Error("Compact syntax palette exceeded Uint16 style IDs.");
  }

  foregroundPalette.push(foreground);
  const styleId = foregroundPalette.length;
  paletteIds.set(normalizedForeground, styleId);
  return styleId;
}

/** Encode one side's HAST lines in one traversal without retaining token text in the result. */
function encodeSide({
  lines,
  appearance,
  foregroundPalette,
  paletteIds,
  preserveWordDiff,
}: {
  lines: HighlightedHastLines;
  appearance: "dark" | "light";
  foregroundPalette: string[];
  paletteIds: Map<string, number>;
  preserveWordDiff: boolean;
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
      side.flags.push(preserveWordDiff && run.wordDiff ? COMPACT_HIGHLIGHT_FLAG_WORD_DIFF : 0);
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

/** Convert one document's HAST lines into a text-free compact artifact. */
export function encodeCompactHighlightedDocument(
  lines: HighlightedHastLines,
  appearance: "dark" | "light",
): CompactHighlightedDocument {
  const foregroundPalette: string[] = [];
  return {
    version: COMPACT_HIGHLIGHT_PROTOCOL_VERSION,
    foregroundPalette,
    document: encodeSide({
      lines,
      appearance,
      foregroundPalette,
      paletteIds: new Map(),
      preserveWordDiff: false,
    }),
  };
}

/**
 * Converts Pierre HAST into a text-free worker response.
 *
 * The receiving terminal retains the original diff text and reconstructs terminal spans from the
 * numeric ranges. Colors deliberately remain palette values while word-diff background stays a
 * semantic flag so each row can apply its existing theme policy.
 */
export function encodeCompactHighlightedDiff(
  code: {
    deletionLines: HighlightedHastLines;
    additionLines: HighlightedHastLines;
  },
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
      preserveWordDiff: true,
    }),
    addition: encodeSide({
      lines: code.additionLines,
      appearance,
      foregroundPalette,
      paletteIds,
      preserveWordDiff: true,
    }),
  };
}

/** Return one document's typed-array buffers for a zero-copy worker response transfer. */
function sideTransferList(side: CompactHighlightSide) {
  return [
    side.lineOffsets.buffer,
    side.starts.buffer,
    side.ends.buffer,
    side.styleIds.buffer,
    side.flags.buffer,
  ];
}

/** Return the transferable buffers that contain one document's compact numeric fields. */
export function compactHighlightedDocumentTransferList(payload: CompactHighlightedDocument) {
  return sideTransferList(payload.document);
}

/** Return the transferable buffers that contain every numeric compact response field. */
export function compactHighlightTransferList(payload: CompactHighlightedDiff) {
  return [...sideTransferList(payload.deletion), ...sideTransferList(payload.addition)];
}

/** Clone numeric runs so transferring a result cannot detach a cached artifact. */
function cloneSide(side: CompactHighlightSide): CompactHighlightSide {
  return {
    lineOffsets: side.lineOffsets.slice(),
    starts: side.starts.slice(),
    ends: side.ends.slice(),
    styleIds: side.styleIds.slice(),
    flags: side.flags.slice(),
  };
}

/** Clone one document before transferring it so a worker-owned cache keeps its buffers. */
export function cloneCompactHighlightedDocument(
  payload: CompactHighlightedDocument,
): CompactHighlightedDocument {
  return {
    version: payload.version,
    foregroundPalette: [...payload.foregroundPalette],
    document: cloneSide(payload.document),
  };
}

/** Clone one diff payload before transferring it so a worker-owned cache keeps its buffers. */
export function cloneCompactHighlightedDiff(
  payload: CompactHighlightedDiff,
): CompactHighlightedDiff {
  return {
    version: payload.version,
    foregroundPalette: [...payload.foregroundPalette],
    deletion: cloneSide(payload.deletion),
    addition: cloneSide(payload.addition),
  };
}

/** Count the encoded bytes retained by a compact color palette. */
function paletteByteLength(foregroundPalette: readonly string[]) {
  return new TextEncoder().encode(JSON.stringify(foregroundPalette)).byteLength;
}

/** Estimate one document's retained wire size, including its cloned color palette. */
export function compactHighlightedDocumentByteLength(payload: CompactHighlightedDocument) {
  const numericBytes = compactHighlightedDocumentTransferList(payload).reduce(
    (total, buffer) => total + buffer.byteLength,
    0,
  );
  return numericBytes + paletteByteLength(payload.foregroundPalette);
}

/** Estimate the retained diff wire size, including the small cloned color palette. */
export function compactHighlightedDiffByteLength(payload: CompactHighlightedDiff) {
  const numericBytes = compactHighlightTransferList(payload).reduce(
    (total, buffer) => total + buffer.byteLength,
    0,
  );
  return numericBytes + paletteByteLength(payload.foregroundPalette);
}

/** Validate one compact side before it enters a cache or renderer. */
function validateSide({
  side,
  paletteLength,
  lineLengths,
  name,
  allowWordDiff,
}: {
  side: CompactHighlightSide;
  paletteLength: number;
  lineLengths?: readonly number[];
  name: string;
  allowWordDiff: boolean;
}) {
  if (
    !side ||
    typeof side !== "object" ||
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

  if (side.lineOffsets[0] !== 0) {
    throw new Error(`Compact ${name} highlight offsets must start at zero.`);
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
      if ((flags & ~COMPACT_HIGHLIGHT_FLAG_WORD_DIFF) !== 0 || (!allowWordDiff && flags !== 0)) {
        throw new Error(`Compact ${name} highlight contains unsupported flags.`);
      }
      previousEnd = end;
    }

    if (startOffset < endOffset && lineLength !== undefined && previousEnd !== lineLength) {
      throw new Error(`Compact ${name} highlight ranges do not cover line ${lineIndex}.`);
    }
  }
}

/** Validate the shared compact envelope fields before inspecting numeric runs. */
function validatePayloadEnvelope(
  payload: Pick<CompactHighlightedDocument, "version" | "foregroundPalette">,
) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Compact highlight payload must be an object.");
  }
  if (payload.version !== COMPACT_HIGHLIGHT_PROTOCOL_VERSION) {
    throw new Error(`Unsupported compact highlight protocol version: ${String(payload.version)}`);
  }
  if (
    !Array.isArray(payload.foregroundPalette) ||
    payload.foregroundPalette.length > 0xffff ||
    payload.foregroundPalette.some(
      (color) => typeof color !== "string" || !COMPACT_PALETTE_COLOR_PATTERN.test(color),
    )
  ) {
    throw new Error("Compact syntax palette contains an invalid color.");
  }
}

/** Validate one received document before it enters a cache or renderer. */
export function validateCompactHighlightedDocument(
  payload: CompactHighlightedDocument,
  lineLengths?: readonly number[],
) {
  validatePayloadEnvelope(payload);
  validateSide({
    side: payload.document,
    paletteLength: payload.foregroundPalette.length,
    lineLengths,
    name: "document",
    allowWordDiff: false,
  });
}

/** Validate a received compact diff before it enters a cache or renderer. */
export function validateCompactHighlightedDiff(
  payload: CompactHighlightedDiff,
  lineLengths?: {
    deletion: readonly number[];
    addition: readonly number[];
  },
) {
  validatePayloadEnvelope(payload);

  validateSide({
    side: payload.deletion,
    paletteLength: payload.foregroundPalette.length,
    lineLengths: lineLengths?.deletion,
    name: "deletion",
    allowWordDiff: true,
  });
  validateSide({
    side: payload.addition,
    paletteLength: payload.foregroundPalette.length,
    lineLengths: lineLengths?.addition,
    name: "addition",
    allowWordDiff: true,
  });
}

/** Decode one numeric line without rebuilding HAST nodes or token text. */
function runsForSide(
  side: CompactHighlightSide,
  foregroundPalette: readonly string[],
  lineIndex: number,
  name: string,
): CompactHighlightRun[] {
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= side.lineOffsets.length - 1) {
    throw new Error(`Compact ${name} highlight line index is outside its payload.`);
  }

  const startOffset = side.lineOffsets[lineIndex]!;
  const endOffset = side.lineOffsets[lineIndex + 1]!;
  const runs: CompactHighlightRun[] = [];
  for (let runIndex = startOffset; runIndex < endOffset; runIndex += 1) {
    const styleId = side.styleIds[runIndex]!;
    runs.push({
      start: side.starts[runIndex]!,
      end: side.ends[runIndex]!,
      fg: styleId === 0 ? undefined : foregroundPalette[styleId - 1],
      wordDiff: (side.flags[runIndex]! & COMPACT_HIGHLIGHT_FLAG_WORD_DIFF) !== 0,
    });
  }
  return runs;
}

/** Read one compact document line's syntax styles without exposing diff-only emphasis flags. */
export function compactHighlightedDocumentRunsForLine(
  payload: CompactHighlightedDocument,
  lineIndex: number,
): CompactDocumentHighlightRun[] {
  return runsForSide(payload.document, payload.foregroundPalette, lineIndex, "document").map(
    ({ start, end, fg }) => ({ start, end, fg }),
  );
}

/** Read one compact diff line's styles without rebuilding HAST nodes or token text. */
export function compactHighlightRunsForLine(
  payload: CompactHighlightedDiff,
  sideName: "deletion" | "addition",
  lineIndex: number,
): CompactHighlightRun[] {
  return runsForSide(payload[sideName], payload.foregroundPalette, lineIndex, sideName);
}

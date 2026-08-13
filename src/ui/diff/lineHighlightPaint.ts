/**
 * Paint-time resolution of extension line highlights.
 *
 * Extensions address marks by source coordinates — `(side, line, [start, end))`
 * in UTF-16 code units of the raw line text. Diff cells render text that has
 * already been terminal-sanitized and tab-expanded, so this module owns the one
 * mapping from source offsets to terminal columns and the one span transform
 * that paints them. Everything here is geometry-neutral by construction:
 * applying a highlight splits spans at column boundaries and changes
 * backgrounds, never text, so measured widths, wrapping, and row heights are
 * untouched and `buildDiffSectionRowPlan`'s cache never learns highlights
 * exist.
 */
import {
  reviewExpansionSide,
  reviewLeadingGap,
  reviewTrailingGap,
  type ReviewGapAddress,
} from "../../core/review/expansion";
import { normalizedReviewSourceLines } from "../../core/review/geometry";
import { DEFAULT_TAB_WIDTH } from "../../core/tabWidth";
import type { DiffFile } from "../../core/types";
import type { ExtensionLineHighlightTone } from "../../extension-api/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import type { ValidatedLineHighlight } from "../highlights/validate";
import { measureTextWidth, sliceTextByWidth, textClusters } from "../lib/text";
import { expandDiffTabs } from "./codeColumns";
import type { RenderSpan } from "./pierre";

/** One mark resolved to terminal columns of the rendered (expanded) line. */
export interface LineHighlightColRange {
  readonly startCol: number;
  readonly endCol: number;
  readonly tone: ExtensionLineHighlightTone;
}

/**
 * Column ranges per rendered line, keyed by `lineHighlightPaintKey`.
 *
 * A context line is registered under both its old and new key with one shared
 * range list, so split view mirrors the mark onto both halves and stack view
 * finds it through either line number.
 */
export type LineHighlightPaintIndex = ReadonlyMap<string, readonly LineHighlightColRange[]>;

/** Key one rendered line by the side and 1-based line number a cell carries. */
export function lineHighlightPaintKey(side: "old" | "new", line: number) {
  return `${side}:${line}`;
}

/** Strip one trailing newline the way diff rendering does before measuring. */
function stripTrailingNewline(text: string) {
  return text.replace(/\n$/, "");
}

/**
 * Snap one code-unit offset in sanitized text to a grapheme-cluster boundary.
 *
 * A mid-cluster offset widens outward (`start` down, `end` up) so a bad offset
 * marks the whole visible glyph instead of tearing it.
 */
function snapToClusterBoundary(text: string, offset: number, direction: "down" | "up") {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;

  let boundary = 0;
  for (const cluster of textClusters(text)) {
    const next = boundary + cluster.length;
    if (next === offset) return offset;
    if (next > offset) {
      return direction === "down" ? boundary : next;
    }
    boundary = next;
  }
  return text.length;
}

/**
 * Map one raw-text code-unit offset to a sanitized-text offset.
 *
 * Sanitization mostly leaves source code untouched; when it does strip control
 * sequences, sanitizing the raw prefix approximates the shifted offset. A
 * sequence straddling the cut can round the answer by a few code units, which
 * cluster snapping then contains to whole glyphs.
 */
function rawOffsetToSanitizedOffset(raw: string, sanitized: string, offset: number) {
  const clamped = Math.max(0, Math.min(offset, raw.length));
  if (raw === sanitized) {
    return clamped;
  }
  return Math.min(sanitizeTerminalLine(raw.slice(0, clamped)).length, sanitized.length);
}

/** Resolve one mark against its raw line text into terminal columns. */
function markToColRange(
  mark: ValidatedLineHighlight,
  rawText: string,
  tabWidth: number,
): LineHighlightColRange | null {
  const raw = stripTrailingNewline(rawText);
  const sanitized = sanitizeTerminalLine(raw);
  if (sanitized.length === 0) {
    return null;
  }

  const start = snapToClusterBoundary(
    sanitized,
    rawOffsetToSanitizedOffset(raw, sanitized, mark.start),
    "down",
  );
  const end = snapToClusterBoundary(
    sanitized,
    rawOffsetToSanitizedOffset(raw, sanitized, mark.end),
    "up",
  );
  if (start >= end) {
    return null;
  }

  // A prefix expands to the same columns the full line's expansion gives it,
  // because tab stops depend only on the columns already consumed.
  const startCol = measureTextWidth(expandDiffTabs(sanitized.slice(0, start), tabWidth));
  const endCol = measureTextWidth(expandDiffTabs(sanitized.slice(0, end), tabWidth));
  return endCol > startCol ? { startCol, endCol, tone: mark.tone } : null;
}

/** The raw text one addressed line renders, plus the counterpart key of a context pair. */
interface AddressedLine {
  rawText: string;
  /** The same physical line's key on the other side, for context and gap lines. */
  counterpartKey?: string;
}

/** Walk the patch once, resolving every addressed `(side, line)` to its raw text. */
function resolvePatchLines(file: DiffFile, addressedKeys: ReadonlySet<string>) {
  const resolved = new Map<string, AddressedLine>();
  const metadata = file.metadata;

  for (const hunk of metadata.hunks) {
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const oldKey = lineHighlightPaintKey("old", oldLine + offset);
          const newKey = lineHighlightPaintKey("new", newLine + offset);
          if (!addressedKeys.has(oldKey) && !addressedKeys.has(newKey)) continue;
          const rawText =
            metadata.additionLines[additionLineIndex + offset] ??
            metadata.deletionLines[deletionLineIndex + offset];
          if (rawText === undefined) continue;
          resolved.set(oldKey, { rawText, counterpartKey: newKey });
          resolved.set(newKey, { rawText, counterpartKey: oldKey });
        }
        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        oldLine += content.lines;
        newLine += content.lines;
        continue;
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        const key = lineHighlightPaintKey("old", oldLine + offset);
        if (!addressedKeys.has(key)) continue;
        const rawText = metadata.deletionLines[deletionLineIndex + offset];
        if (rawText !== undefined) resolved.set(key, { rawText });
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        const key = lineHighlightPaintKey("new", newLine + offset);
        if (!addressedKeys.has(key)) continue;
        const rawText = metadata.additionLines[additionLineIndex + offset];
        if (rawText !== undefined) resolved.set(key, { rawText });
      }
      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
      oldLine += content.deletions;
      newLine += content.additions;
    }
  }

  return resolved;
}

/** Every collapsed gap of one file, in the addressing shared with expansion rows. */
function fileGapAddresses(file: DiffFile): ReviewGapAddress[] {
  const gaps: ReviewGapAddress[] = [];
  for (let hunkIndex = 0; hunkIndex < file.metadata.hunks.length; hunkIndex += 1) {
    const leading = reviewLeadingGap(file.metadata, hunkIndex);
    if (leading) gaps.push(leading);
  }
  const trailing = reviewTrailingGap(file.metadata);
  if (trailing) gaps.push(trailing);
  return gaps;
}

/**
 * Resolve addressed lines that live inside collapsed gaps against loaded source.
 *
 * Gap rows render text sliced from the expansion side's full source, so a mark
 * on either side of a gap line maps through the gap's old↔new correspondence
 * to that source line. Without loaded source the marks simply stay invisible,
 * matching the rows themselves.
 */
function resolveGapLines(
  file: DiffFile,
  addressedKeys: ReadonlySet<string>,
  resolved: Map<string, AddressedLine>,
  sourceText: string,
) {
  const pending = [...addressedKeys].filter((key) => !resolved.has(key));
  if (pending.length === 0) return;

  const expansionSide = reviewExpansionSide(file.metadata.type);
  const sourceLines = normalizedReviewSourceLines(sourceText);
  const gaps = fileGapAddresses(file);

  for (const key of pending) {
    const [side, lineText] = key.split(":") as ["old" | "new", string];
    const line = Number(lineText);
    for (const gap of gaps) {
      const range = side === "old" ? gap.oldRange : gap.newRange;
      if (line < range[0] || line > range[1]) continue;
      const offset = line - range[0];
      const otherRange = side === "old" ? gap.newRange : gap.oldRange;
      const counterpart = otherRange[0] + offset;
      const expansionLine = side === expansionSide ? line : counterpart;
      const rawText = sourceLines[expansionLine - 1];
      if (rawText === undefined) break;
      const counterpartKey = lineHighlightPaintKey(side === "old" ? "new" : "old", counterpart);
      resolved.set(key, { rawText, counterpartKey });
      resolved.set(counterpartKey, { rawText, counterpartKey: key });
      break;
    }
  }
}

/**
 * Resolve validated marks into the per-line column ranges paint consults.
 *
 * Marks addressing lines the review cannot show (inside a collapsed,
 * unexpanded gap without loaded source, or absent from a partial patch) are
 * silently invisible — the mark is valid, the line just is not rendered.
 * Ranges are sorted by start column; paint applies them in order with later
 * ranges winning overlaps, so the result is deterministic.
 */
export function buildLineHighlightPaintIndex({
  file,
  marks,
  tabWidth = DEFAULT_TAB_WIDTH,
  sourceText,
}: {
  file: DiffFile;
  marks: readonly ValidatedLineHighlight[];
  tabWidth?: number;
  /** Loaded full source for the expansion side, covering expanded gap rows. */
  sourceText?: string;
}): LineHighlightPaintIndex | undefined {
  if (marks.length === 0) {
    return undefined;
  }

  const marksByKey = new Map<string, ValidatedLineHighlight[]>();
  for (const mark of marks) {
    const key = lineHighlightPaintKey(mark.side, mark.line);
    const bucket = marksByKey.get(key);
    if (bucket) {
      bucket.push(mark);
    } else {
      marksByKey.set(key, [mark]);
    }
  }

  const addressedKeys = new Set(marksByKey.keys());
  const lines = resolvePatchLines(file, addressedKeys);
  if (sourceText !== undefined) {
    resolveGapLines(file, addressedKeys, lines, sourceText);
  }

  const index = new Map<string, LineHighlightColRange[]>();
  // One shared array per physical line: context and gap marks register the
  // same bucket under both side keys, so split view mirrors them and stack
  // view finds one list through either line number without double-counting.
  const bucketFor = (key: string, counterpartKey: string | undefined) => {
    let bucket = index.get(key) ?? (counterpartKey ? index.get(counterpartKey) : undefined);
    if (!bucket) {
      bucket = [];
    }
    index.set(key, bucket);
    if (counterpartKey) {
      index.set(counterpartKey, bucket);
    }
    return bucket;
  };

  for (const [key, keyMarks] of marksByKey) {
    const line = lines.get(key);
    if (!line) continue;
    for (const mark of keyMarks) {
      const range = markToColRange(mark, line.rawText, tabWidth);
      if (!range) continue;
      bucketFor(key, line.counterpartKey).push(range);
    }
  }

  for (const [key, bucket] of index) {
    if (bucket.length === 0) {
      index.delete(key);
    }
  }
  if (index.size === 0) {
    return undefined;
  }

  for (const ranges of index.values()) {
    ranges.sort((a, b) => a.startCol - b.startCol || a.endCol - b.endCol);
  }
  return index;
}

/** Append a span preserving color-run coalescing. */
function appendSpan(target: RenderSpan[], span: RenderSpan) {
  const previous = target.at(-1);
  if (previous && previous.fg === span.fg && previous.bg === span.bg) {
    previous.text += span.text;
  } else {
    target.push(span);
  }
}

/** The tone painting one column, with later ranges winning overlaps. */
function toneAtColumn(ranges: readonly LineHighlightColRange[], col: number) {
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    if (col >= range.startCol && col < range.endCol) {
      return range.tone;
    }
  }
  return undefined;
}

/** The resolved paint for one tone: a background, plus a foreground when the mark inverts. */
export interface LineHighlightSpanStyle {
  bg: string;
  fg?: string;
}

/**
 * Repaint span colors over highlighted column ranges.
 *
 * Returns new span objects — cell spans are shared cached arrays (context
 * cells even share one array across sides) and must never be mutated. Text is
 * preserved exactly, so this cannot move geometry. `resolveStyle` returning
 * `undefined` leaves the original colors, degrading like word diff does on
 * surfaces that cannot take a blend; a style carrying `fg` (reverse-video
 * marks) overrides the span foreground as well.
 */
export function applyLineHighlightsToSpans(
  spans: readonly RenderSpan[],
  ranges: readonly LineHighlightColRange[],
  resolveStyle: (tone: ExtensionLineHighlightTone) => LineHighlightSpanStyle | undefined,
): RenderSpan[] {
  if (ranges.length === 0) {
    return [...spans];
  }

  // Cut at every range boundary so each emitted piece has one winning tone.
  const cuts = new Set<number>();
  for (const range of ranges) {
    cuts.add(range.startCol);
    cuts.add(range.endCol);
  }

  const result: RenderSpan[] = [];
  let col = 0;

  for (const span of spans) {
    const spanWidth = measureTextWidth(span.text);
    if (spanWidth === 0) {
      appendSpan(result, { ...span });
      continue;
    }

    const spanStart = col;
    const spanEnd = col + spanWidth;
    const localCuts = [...cuts]
      .filter((cut) => cut > spanStart && cut < spanEnd)
      // A cut inside a wide glyph would slice it into a dropped half and a pad
      // space, costing the row one column and breaking the one contract
      // everything upstream relies on: paint never changes rendered width.
      // Cluster snapping upstream should make this unreachable, but the
      // invariant is enforced here, where it could break: a mid-glyph cut is
      // snapped away and the glyph paints whole under one tone.
      .filter((cut) => sliceTextByWidth(span.text, 0, cut - spanStart).width === cut - spanStart)
      .sort((a, b) => a - b);

    let pieceStart = spanStart;
    for (const boundary of [...localCuts, spanEnd]) {
      const piece =
        localCuts.length === 0
          ? span.text
          : sliceTextByWidth(span.text, pieceStart - spanStart, boundary - pieceStart).text;
      if (piece.length > 0) {
        const tone = toneAtColumn(ranges, pieceStart);
        const style = tone === undefined ? undefined : resolveStyle(tone);
        appendSpan(
          result,
          style === undefined
            ? { ...span, text: piece }
            : style.fg === undefined
              ? { ...span, text: piece, bg: style.bg }
              : { ...span, text: piece, bg: style.bg, fg: style.fg },
        );
      }
      pieceStart = boundary;
    }

    col = spanEnd;
  }

  return result;
}

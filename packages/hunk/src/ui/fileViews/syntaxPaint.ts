import type { ExtensionFileViewSpan } from "../../extension-api/types";
import {
  documentHighlightRunsForLine,
  type DocumentHighlightResult,
  type DocumentHighlightRun,
} from "../diff/documentHighlightService";

/** One paint-only syntax run that retains text from an accepted symbolic span. */
export interface FileViewSyntaxPaintRun {
  readonly text: string;
  readonly fg?: string;
}

interface ProjectedLine {
  readonly length: number;
  readonly runs: readonly DocumentHighlightRun[];
}

/** Return whether service-projected ranges cover one complete document line exactly. */
function projectedLineLength(runs: readonly DocumentHighlightRun[]) {
  let cursor = 0;
  for (const run of runs) {
    if (
      !Number.isInteger(run.start) ||
      !Number.isInteger(run.end) ||
      run.start !== cursor ||
      run.end <= run.start
    ) {
      return null;
    }
    cursor = run.end;
  }
  return cursor;
}

/** Return the first run whose end may intersect `column`. */
function firstIntersectingRun(runs: readonly DocumentHighlightRun[], column: number) {
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (runs[middle]!.end <= column) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Coalesce adjacent foregrounds after clipping. */
function coalescePaintRuns(runs: readonly FileViewSyntaxPaintRun[]) {
  const coalesced: FileViewSyntaxPaintRun[] = [];
  for (const run of runs) {
    const previous = coalesced.at(-1);
    if (previous && previous.fg === run.fg) {
      coalesced[coalesced.length - 1] = {
        ...previous,
        text: previous.text + run.text,
      };
    } else {
      coalesced.push(run.fg === undefined ? { text: run.text } : { text: run.text, fg: run.fg });
    }
  }
  return coalesced;
}

/**
 * Cache service line projections for one row render and clip spans with indexed range lookup.
 * The cache is local to its caller, so a mounted 40,000-span row cannot multiply line artifacts.
 */
export function createFileViewSyntaxProjector(
  highlights: ReadonlyMap<string, DocumentHighlightResult>,
) {
  const projectedLines = new WeakMap<DocumentHighlightResult, Map<number, ProjectedLine | null>>();
  let projectedLineCount = 0;

  /** Load and validate one line at most once for this projector's lifetime. */
  const projectedLine = (result: DocumentHighlightResult, lineIndex: number) => {
    let lines = projectedLines.get(result);
    if (!lines) {
      lines = new Map();
      projectedLines.set(result, lines);
    }
    if (lines.has(lineIndex)) return lines.get(lineIndex) ?? null;

    let projected: DocumentHighlightRun[];
    try {
      projectedLineCount += 1;
      projected = documentHighlightRunsForLine(result, lineIndex);
    } catch {
      lines.set(lineIndex, null);
      return null;
    }
    const length = projectedLineLength(projected);
    const value = projected.length > 0 && length !== null ? { length, runs: projected } : null;
    lines.set(lineIndex, value);
    return value;
  };

  /** Project one validated symbolic span without replacing its retained text. */
  const projectSpan = (span: ExtensionFileViewSpan): readonly FileViewSyntaxPaintRun[] | null => {
    const reference = span.syntax;
    if (!reference || span.text.length === 0) return null;

    const result = highlights.get(reference.documentId);
    if (!result || result.status !== "highlighted") return null;
    if (!Number.isInteger(reference.line) || reference.line < 1) return null;

    const line = projectedLine(result, reference.line - 1);
    if (!line) return null;

    const sliceStart = reference.range?.[0] ?? 0;
    const sliceEnd = reference.range?.[1] ?? line.length;
    if (
      !Number.isInteger(sliceStart) ||
      !Number.isInteger(sliceEnd) ||
      sliceStart < 0 ||
      sliceEnd < sliceStart ||
      sliceEnd > line.length ||
      sliceEnd - sliceStart !== span.text.length
    ) {
      return null;
    }

    const clipped: FileViewSyntaxPaintRun[] = [];
    let localCursor = 0;
    for (
      let index = firstIntersectingRun(line.runs, sliceStart);
      index < line.runs.length;
      index += 1
    ) {
      const run = line.runs[index]!;
      if (run.start >= sliceEnd) break;
      const start = Math.max(run.start, sliceStart);
      const end = Math.min(run.end, sliceEnd);
      if (start >= end) continue;

      const localStart = start - sliceStart;
      const localEnd = end - sliceStart;
      if (localStart !== localCursor || localEnd > span.text.length) return null;
      clipped.push({ text: span.text.slice(localStart, localEnd), fg: run.fg });
      localCursor = localEnd;
    }
    if (localCursor !== span.text.length || clipped.length === 0) return null;

    return coalescePaintRuns(clipped).map((run) => Object.freeze(run));
  };

  return {
    projectSpan,
    /** Exposes structural cache evidence to focused tests without retaining projected source. */
    get projectedLineCount() {
      return projectedLineCount;
    },
  };
}

export type FileViewSyntaxProjector = ReturnType<typeof createFileViewSyntaxProjector>;

/**
 * Project host syntax colors onto one validated symbolic span without replacing its retained text.
 * Invalid, stale, unavailable, or incomplete projections return `null` for ordinary tone fallback.
 */
export function projectFileViewSyntaxSpan(
  span: ExtensionFileViewSpan,
  highlights: ReadonlyMap<string, DocumentHighlightResult>,
): readonly FileViewSyntaxPaintRun[] | null {
  return createFileViewSyntaxProjector(highlights).projectSpan(span);
}

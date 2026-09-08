import type { ExtensionFileViewSpan } from "../../extension-api/types";
import {
  documentHighlightRunsForLine,
  type DocumentHighlightResult,
  type DocumentHighlightRun,
} from "../diff/documentHighlightService";
import type { RenderSpan } from "../diff/diffRows";
import { preserveCrossSpanGraphemes } from "../diff/styledSpanLayout";

/** One paint-only syntax run that retains text from an accepted symbolic span. */
export interface FileViewSyntaxPaintRun {
  readonly text: string;
  readonly fg?: string;
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

/** Coalesce adjacent foregrounds after grapheme-safe boundary resolution. */
function coalescePaintRuns(runs: readonly RenderSpan[]) {
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
 * Project host syntax colors onto one validated symbolic span without replacing its retained text.
 * Invalid, stale, unavailable, or incomplete projections return `null` for ordinary tone fallback.
 */
export function projectFileViewSyntaxSpan(
  span: ExtensionFileViewSpan,
  highlights: ReadonlyMap<string, DocumentHighlightResult>,
): readonly FileViewSyntaxPaintRun[] | null {
  const reference = span.syntax;
  if (!reference || span.text.length === 0) return null;

  const result = highlights.get(reference.documentId);
  if (!result || result.status !== "highlighted") return null;
  if (!Number.isInteger(reference.line) || reference.line < 1) return null;

  let projected: DocumentHighlightRun[];
  try {
    projected = documentHighlightRunsForLine(result, reference.line - 1);
  } catch {
    return null;
  }
  if (projected.length === 0) return null;
  const lineLength = projectedLineLength(projected);
  if (lineLength === null) return null;

  const sliceStart = reference.range?.[0] ?? 0;
  const sliceEnd = reference.range?.[1] ?? lineLength;
  if (
    !Number.isInteger(sliceStart) ||
    !Number.isInteger(sliceEnd) ||
    sliceStart < 0 ||
    sliceEnd < sliceStart ||
    sliceEnd > lineLength ||
    sliceEnd - sliceStart !== span.text.length
  ) {
    return null;
  }

  const clipped: RenderSpan[] = [];
  let localCursor = 0;
  for (const run of projected) {
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

  const graphemeSafe = preserveCrossSpanGraphemes(clipped);
  const runs = coalescePaintRuns(graphemeSafe);
  return runs.map((run) => Object.freeze(run));
}

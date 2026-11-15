import type { ExtensionLineHighlightTone } from "../../extension-api/types";

/**
 * Containment caps for one highlighter's marks on one file.
 *
 * Past a cap the file's marks from that highlighter are dropped whole rather
 * than truncated silently: a truncated set would look like the highlighter
 * worked while showing an arbitrary subset of what it said.
 */
export const MAX_LINE_HIGHLIGHTS_PER_FILE = 2_000;
export const MAX_LINE_HIGHLIGHTS_PER_LINE = 100;
/**
 * Cap on raw entries validated for one file.
 *
 * The caps above count marks that survived validation, so an array of pure
 * garbage costs a full structural pass no matter how long it is. A result this
 * long cannot yield a usable mark set anyway, so it is rejected unread.
 */
export const MAX_LINE_HIGHLIGHT_INPUT_ENTRIES = 10_000;
/**
 * Cap on the marks one file keeps after merging every highlighter's result.
 *
 * The per-highlighter caps bound one contributor; this bounds what paint has to
 * carry when several contributors mark the same file at once.
 */
export const MAX_MERGED_LINE_HIGHLIGHTS_PER_FILE = 4_000;

const LINE_HIGHLIGHT_TONES: ReadonlySet<string> = new Set([
  "match",
  "current",
  "info",
  "warning",
  "error",
  "dim",
]);

/** One structurally valid mark, with the tone default applied. */
export interface ValidatedLineHighlight {
  readonly side: "old" | "new";
  /** 1-based source line number on `side`. */
  readonly line: number;
  /** `[start, end)` UTF-16 code-unit offsets into the line's raw source text. */
  readonly start: number;
  readonly end: number;
  readonly tone: ExtensionLineHighlightTone;
}

/** How one highlighter's result for one file settled. */
export type LineHighlightValidation =
  | {
      readonly ok: true;
      readonly marks: readonly ValidatedLineHighlight[];
      /** Structurally invalid entries dropped from an otherwise usable result. */
      readonly droppedInvalid: number;
    }
  | { readonly ok: false; readonly issue: string };

/** Return whether one value is a usable non-negative integer. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validate one raw entry into a mark, or `null` when it is structural garbage. */
function validateEntry(entry: unknown): ValidatedLineHighlight | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const candidate = entry as {
    side?: unknown;
    line?: unknown;
    range?: unknown;
    tone?: unknown;
  };
  if (candidate.side !== "old" && candidate.side !== "new") {
    return null;
  }
  if (!isNonNegativeInteger(candidate.line) || candidate.line < 1) {
    return null;
  }
  if (!Array.isArray(candidate.range) || candidate.range.length !== 2) {
    return null;
  }
  const [start, end] = candidate.range as [unknown, unknown];
  // Empty and inverted ranges are dropped rather than clamped: a zero-width
  // mark has no visible meaning, and widening it silently would invent one.
  if (!isNonNegativeInteger(start) || !isNonNegativeInteger(end) || start >= end) {
    return null;
  }
  if (candidate.tone !== undefined && !LINE_HIGHLIGHT_TONES.has(candidate.tone as string)) {
    return null;
  }

  return {
    side: candidate.side,
    line: candidate.line,
    start,
    end,
    tone: (candidate.tone as ExtensionLineHighlightTone | undefined) ?? "match",
  };
}

/**
 * Validate one highlighter's raw result for one file.
 *
 * `null` and empty arrays are ordinary "no marks" answers. Invalid entries are
 * dropped individually and counted so the caller can warn once per file;
 * exceeding a containment cap rejects the whole result instead.
 */
export function validateLineHighlights(result: unknown): LineHighlightValidation {
  if (result === null || result === undefined) {
    return { ok: true, marks: [], droppedInvalid: 0 };
  }
  if (!Array.isArray(result)) {
    return { ok: false, issue: "returned a non-array result" };
  }
  if (result.length > MAX_LINE_HIGHLIGHT_INPUT_ENTRIES) {
    return {
      ok: false,
      issue: `returned more than ${MAX_LINE_HIGHLIGHT_INPUT_ENTRIES} entries for one file`,
    };
  }

  const marks: ValidatedLineHighlight[] = [];
  const perLine = new Map<string, number>();
  let droppedInvalid = 0;

  for (const entry of result) {
    const mark = validateEntry(entry);
    if (!mark) {
      droppedInvalid += 1;
      continue;
    }
    if (marks.length >= MAX_LINE_HIGHLIGHTS_PER_FILE) {
      return {
        ok: false,
        issue: `returned more than ${MAX_LINE_HIGHLIGHTS_PER_FILE} ranges for one file`,
      };
    }
    const lineKey = `${mark.side}:${mark.line}`;
    const lineCount = (perLine.get(lineKey) ?? 0) + 1;
    if (lineCount > MAX_LINE_HIGHLIGHTS_PER_LINE) {
      return {
        ok: false,
        issue: `returned more than ${MAX_LINE_HIGHLIGHTS_PER_LINE} ranges on one line`,
      };
    }
    perLine.set(lineKey, lineCount);
    marks.push(mark);
  }

  return { ok: true, marks, droppedInvalid };
}

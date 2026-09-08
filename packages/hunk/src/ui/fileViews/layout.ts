import type {
  ExtensionFileSide,
  ExtensionFileViewCodeDocument,
  ExtensionFileViewLayout,
  ExtensionFileViewRow,
  ExtensionFileViewSourceRange,
  ExtensionFileViewSyntaxReference,
} from "../../extension-api/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { wrapSanitizedTextByWidth } from "../lib/text";

/** Resource limits keep one extension layout from exhausting the review stream. */
export const FILE_VIEW_MAX_ROWS = 10_000;
export const FILE_VIEW_MAX_SPANS = 40_000;
export const FILE_VIEW_MAX_TEXT_LENGTH = 1_000_000;
export const FILE_VIEW_MAX_COMPONENT_ROW_HEIGHT = 256;
export const FILE_VIEW_MAX_SOURCE_RANGES = 40_000;
export const FILE_VIEW_MAX_CODE_DOCUMENTS = 64;
export const FILE_VIEW_MAX_CODE_DOCUMENT_TEXT_LENGTH = 1_000_000;
export const FILE_VIEW_MAX_CODE_DOCUMENT_LINES = 10_000;
export const FILE_VIEW_MAX_CODE_DOCUMENT_ID_LENGTH = 256;
export const FILE_VIEW_MAX_CODE_DOCUMENT_LANGUAGE_LENGTH = 100;
/** Maximum measured terminal height across every symbolic and component row. */
export const FILE_VIEW_MAX_LAYOUT_HEIGHT = 100_000;

const FILE_VIEW_TONES = new Set(["muted", "accent", "accent-muted", "syntax", "added", "removed"]);
const FILE_VIEW_TEXT_ATTRIBUTES = new Set(["bold", "italic", "underline", "strikethrough"]);

export interface ValidatedFileViewLayout {
  layout: ExtensionFileViewLayout;
  /** Number of terminal rows each symbolic row occupies at the requested width. */
  rowHeights: readonly number[];
}

/** Validate finite zero-based row coordinates. */
function isRowIndex(value: unknown, rowCount: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < rowCount;
}

interface ValidatedCodeDocument {
  readonly lines: readonly string[];
}

/** Count logical lines without allocating an attacker-controlled split array. */
function boundedCodeDocumentLineCount(text: string, maximum: number) {
  if (text.length === 0) return 0;

  let lineBreaks = 0;
  let endsWithLineBreak = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 0x0a && code !== 0x0d) {
      endsWithLineBreak = false;
      continue;
    }
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index += 1;
    lineBreaks += 1;
    endsWithLineBreak = true;
    if (lineBreaks > maximum) return null;
  }

  const lineCount = lineBreaks + (endsWithLineBreak ? 0 : 1);
  return lineCount <= maximum ? lineCount : null;
}

/** Normalize one code document without changing its logical line count. */
function normalizeCodeDocumentText(text: string) {
  const normalizedNewlines = text.replace(/\r\n?/g, "\n");
  if (normalizedNewlines.length === 0) {
    return { text: "", lines: [] as readonly string[] };
  }

  const hasTerminatingNewline = normalizedNewlines.endsWith("\n");
  const body = hasTerminatingNewline ? normalizedNewlines.slice(0, -1) : normalizedNewlines;
  const lines = body.split("\n").map(sanitizeTerminalLine);
  return {
    text: `${lines.join("\n")}${hasTerminatingNewline ? "\n" : ""}`,
    lines: Object.freeze(lines),
  };
}

/** Validate and snapshot bounded syntax documents before resolving span references. */
function validateCodeDocuments(layout: ExtensionFileViewLayout):
  | {
      valid: true;
      snapshots: readonly ExtensionFileViewCodeDocument[] | undefined;
      byId: ReadonlyMap<string, ValidatedCodeDocument>;
    }
  | { valid: false; issue: string } {
  if (layout.codeDocuments === undefined) {
    return { valid: true, snapshots: undefined, byId: new Map() };
  }
  if (!Array.isArray(layout.codeDocuments)) {
    return { valid: false, issue: "layout.codeDocuments is not an array" };
  }
  if (layout.codeDocuments.length > FILE_VIEW_MAX_CODE_DOCUMENTS) {
    return {
      valid: false,
      issue: `layout has more than ${FILE_VIEW_MAX_CODE_DOCUMENTS} code documents`,
    };
  }

  let textLength = 0;
  let lineCount = 0;
  const ids = new Set<string>();
  const snapshots: ExtensionFileViewCodeDocument[] = [];
  const byId = new Map<string, ValidatedCodeDocument>();
  for (const [index, document] of layout.codeDocuments.entries()) {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      return { valid: false, issue: `codeDocuments[${index}] is not an object` };
    }
    if (
      typeof document.id !== "string" ||
      document.id.length === 0 ||
      document.id.length > FILE_VIEW_MAX_CODE_DOCUMENT_ID_LENGTH ||
      /[\x00-\x1f\x7f-\x9f]/u.test(document.id)
    ) {
      return {
        valid: false,
        issue: `codeDocuments[${index}] has no bounded non-empty id`,
      };
    }
    if (ids.has(document.id)) {
      return { valid: false, issue: `codeDocuments[${index}] repeats id "${document.id}"` };
    }
    if (typeof document.text !== "string") {
      return { valid: false, issue: `codeDocuments[${index}].text is not a string` };
    }
    if (
      document.language !== undefined &&
      (typeof document.language !== "string" ||
        document.language.length === 0 ||
        document.language.length > FILE_VIEW_MAX_CODE_DOCUMENT_LANGUAGE_LENGTH ||
        /\s|[\x00-\x1f\x7f-\x9f]/u.test(document.language))
    ) {
      return {
        valid: false,
        issue: `codeDocuments[${index}].language is not a bounded language id`,
      };
    }

    textLength += document.text.length;
    if (textLength > FILE_VIEW_MAX_CODE_DOCUMENT_TEXT_LENGTH) {
      return {
        valid: false,
        issue: `code document text exceeds ${FILE_VIEW_MAX_CODE_DOCUMENT_TEXT_LENGTH} characters`,
      };
    }
    const documentLineCount = boundedCodeDocumentLineCount(
      document.text,
      FILE_VIEW_MAX_CODE_DOCUMENT_LINES - lineCount,
    );
    if (documentLineCount === null) {
      return {
        valid: false,
        issue: `code documents have more than ${FILE_VIEW_MAX_CODE_DOCUMENT_LINES} lines`,
      };
    }
    lineCount += documentLineCount;
    const normalized = normalizeCodeDocumentText(document.text);

    const snapshot = Object.freeze({
      id: document.id,
      text: normalized.text,
      ...(document.language === undefined ? {} : { language: document.language }),
    });
    ids.add(document.id);
    snapshots.push(snapshot);
    byId.set(document.id, { lines: normalized.lines });
  }

  return { valid: true, snapshots: Object.freeze(snapshots), byId };
}

/** Explain why an extension result cannot safely join the host-owned review stream. */
export function validateFileViewLayout(
  value: unknown,
  hunkCount: number,
  width: number,
): { valid: true; value: ValidatedFileViewLayout } | { valid: false; issue: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, issue: "layout is not an object" };
  }

  const layout = value as ExtensionFileViewLayout;
  if (!Array.isArray(layout.rows) || !Array.isArray(layout.hunkRows)) {
    return {
      valid: false,
      issue: "layout must include rows and hunkRows arrays",
    };
  }
  if (layout.rows.length > FILE_VIEW_MAX_ROWS) {
    return {
      valid: false,
      issue: `layout has more than ${FILE_VIEW_MAX_ROWS} rows`,
    };
  }
  const codeDocuments = validateCodeDocuments(layout);
  if (!codeDocuments.valid) return codeDocuments;

  const ids = new Set<string>();
  let spanCount = 0;
  let sourceRangeCount = 0;
  let textLength = 0;
  let layoutHeight = 0;
  const sourceRangesBySide: Record<
    ExtensionFileSide,
    Array<{ range: readonly [number, number]; rowIndex: number }>
  > = { old: [], new: [] };
  const rows: ExtensionFileViewRow[] = [];
  const rowHeights: number[] = [];
  const usableWidth = Math.max(1, Math.floor(width));

  for (const [index, row] of layout.rows.entries()) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || row.id.length === 0) {
      return { valid: false, issue: `rows[${index}] has no non-empty id` };
    }
    if (ids.has(row.id)) {
      return { valid: false, issue: `rows[${index}] repeats id "${row.id}"` };
    }
    ids.add(row.id);
    const component = row.component;
    let componentSnapshot: ExtensionFileViewRow["component"];
    if (component !== undefined) {
      if (!component || typeof component !== "object" || Array.isArray(component)) {
        return {
          valid: false,
          issue: `rows[${index}].component is not an object`,
        };
      }
      const render = component.render;
      const height = component.height;
      if (typeof render !== "function") {
        return {
          valid: false,
          issue: `rows[${index}].component.render is not a function`,
        };
      }
      if (!Number.isInteger(height) || height < 1 || height > FILE_VIEW_MAX_COMPONENT_ROW_HEIGHT) {
        return {
          valid: false,
          issue: `rows[${index}].component.height must be an integer from 1 to ${FILE_VIEW_MAX_COMPONENT_ROW_HEIGHT}`,
        };
      }
      componentSnapshot = Object.freeze({ height, render });
    }
    if (!Array.isArray(row.spans)) {
      return { valid: false, issue: `rows[${index}].spans is not an array` };
    }

    let rowText = "";
    const spans: ExtensionFileViewRow["spans"][number][] = [];
    for (const span of row.spans) {
      spanCount += 1;
      if (spanCount > FILE_VIEW_MAX_SPANS) {
        return {
          valid: false,
          issue: `layout has more than ${FILE_VIEW_MAX_SPANS} spans`,
        };
      }
      if (!span || typeof span.text !== "string") {
        return {
          valid: false,
          issue: `rows[${index}] contains an invalid span`,
        };
      }
      textLength += span.text.length;
      if (textLength > FILE_VIEW_MAX_TEXT_LENGTH) {
        return {
          valid: false,
          issue: `layout text exceeds ${FILE_VIEW_MAX_TEXT_LENGTH} characters`,
        };
      }
      if (span.text.includes("\n")) {
        return {
          valid: false,
          issue: `rows[${index}] contains an invalid span`,
        };
      }
      if (span.tone !== undefined && !FILE_VIEW_TONES.has(span.tone)) {
        return {
          valid: false,
          issue: `rows[${index}] contains an invalid span tone`,
        };
      }
      if (
        span.attributes !== undefined &&
        (!Array.isArray(span.attributes) ||
          span.attributes.some(
            (attribute: unknown) =>
              typeof attribute !== "string" || !FILE_VIEW_TEXT_ATTRIBUTES.has(attribute),
          ))
      ) {
        return {
          valid: false,
          issue: `rows[${index}] contains invalid span attributes`,
        };
      }
      // Snapshot one terminal-safe representation so validation, geometry, and paint cannot
      // disagree about controls that alter cursor position or terminal state.
      const text = sanitizeTerminalLine(span.text);
      const tone = span.tone;
      const attributes = span.attributes ? Object.freeze([...span.attributes]) : undefined;
      let syntax: ExtensionFileViewSyntaxReference | undefined;
      if (span.syntax !== undefined) {
        const reference = span.syntax;
        if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
          return {
            valid: false,
            issue: `rows[${index}] contains an invalid syntax reference`,
          };
        }
        if (
          typeof reference.documentId !== "string" ||
          reference.documentId.length === 0 ||
          reference.documentId.length > FILE_VIEW_MAX_CODE_DOCUMENT_ID_LENGTH ||
          /[\x00-\x1f\x7f-\x9f]/u.test(reference.documentId)
        ) {
          return {
            valid: false,
            issue: `rows[${index}] contains a syntax reference without a bounded terminal-safe document id`,
          };
        }
        const document = codeDocuments.byId.get(reference.documentId);
        if (!document) {
          return {
            valid: false,
            issue: `rows[${index}] references missing code document "${reference.documentId}"`,
          };
        }
        if (!Number.isInteger(reference.line) || reference.line < 1) {
          return {
            valid: false,
            issue: `rows[${index}] contains a syntax reference with an invalid one-based line`,
          };
        }
        const line = document.lines[reference.line - 1];
        if (line === undefined) {
          return {
            valid: false,
            issue: `rows[${index}] references a line outside code document "${reference.documentId}"`,
          };
        }

        let range: readonly [number, number] | undefined;
        if (reference.range !== undefined) {
          if (
            !Array.isArray(reference.range) ||
            reference.range.length !== 2 ||
            !Number.isInteger(reference.range[0]) ||
            !Number.isInteger(reference.range[1]) ||
            reference.range[0] < 0 ||
            reference.range[0] > reference.range[1] ||
            reference.range[1] > line.length
          ) {
            return {
              valid: false,
              issue: `rows[${index}] contains a syntax reference with an invalid UTF-16 range`,
            };
          }
          range = Object.freeze([reference.range[0], reference.range[1]]) as readonly [
            number,
            number,
          ];
        }
        const referencedText = range === undefined ? line : line.slice(range[0], range[1]);
        if (text !== referencedText) {
          return {
            valid: false,
            issue: `rows[${index}] syntax span text does not match code document "${reference.documentId}"`,
          };
        }
        syntax = Object.freeze({
          documentId: reference.documentId,
          line: reference.line,
          ...(range === undefined ? {} : { range }),
        });
      }
      rowText += text;
      spans.push(
        Object.freeze({
          text,
          ...(tone === undefined ? {} : { tone }),
          ...(attributes === undefined ? {} : { attributes }),
          ...(syntax === undefined ? {} : { syntax }),
        }),
      );
    }
    let sourceRangesSnapshot: readonly ExtensionFileViewSourceRange[] | undefined;
    if (row.sourceRanges !== undefined) {
      if (!Array.isArray(row.sourceRanges)) {
        return { valid: false, issue: `rows[${index}].sourceRanges is not an array` };
      }
      const sourceRanges: ExtensionFileViewSourceRange[] = [];
      for (const [rangeIndex, sourceRange] of row.sourceRanges.entries()) {
        sourceRangeCount += 1;
        if (sourceRangeCount > FILE_VIEW_MAX_SOURCE_RANGES) {
          return {
            valid: false,
            issue: `layout has more than ${FILE_VIEW_MAX_SOURCE_RANGES} source ranges`,
          };
        }
        const side: unknown = sourceRange?.side;
        const range: unknown = sourceRange?.range;
        if (
          !sourceRange ||
          (side !== "old" && side !== "new") ||
          !Array.isArray(range) ||
          range.length !== 2 ||
          !Number.isInteger(range[0]) ||
          !Number.isInteger(range[1]) ||
          range[0] < 1 ||
          range[0] > range[1]
        ) {
          return {
            valid: false,
            issue: `rows[${index}].sourceRanges[${rangeIndex}] is not a valid one-based source range`,
          };
        }
        const rangeSnapshot = Object.freeze([range[0], range[1]]) as readonly [number, number];
        const validatedSide: ExtensionFileSide = side;
        sourceRangesBySide[validatedSide].push({ range: rangeSnapshot, rowIndex: index });
        sourceRanges.push(Object.freeze({ side: validatedSide, range: rangeSnapshot }));
      }
      sourceRangesSnapshot = Object.freeze(sourceRanges);
    }

    // Measure exactly once at validation. Geometry consumes this retained value without rewrapping.
    const rowHeight = componentSnapshot
      ? componentSnapshot.height
      : Math.max(1, wrapSanitizedTextByWidth(rowText, usableWidth).length);
    layoutHeight += rowHeight;
    if (layoutHeight > FILE_VIEW_MAX_LAYOUT_HEIGHT) {
      return {
        valid: false,
        issue: `layout exceeds ${FILE_VIEW_MAX_LAYOUT_HEIGHT} terminal rows`,
      };
    }
    rowHeights.push(rowHeight);
    rows.push(
      Object.freeze({
        id: row.id,
        spans: Object.freeze(spans),
        ...(sourceRangesSnapshot === undefined ? {} : { sourceRanges: sourceRangesSnapshot }),
        ...(componentSnapshot === undefined ? {} : { component: componentSnapshot }),
      }),
    );
  }

  for (const side of ["old", "new"] as const) {
    const sorted = sourceRangesBySide[side].sort(
      (left, right) => left.range[0] - right.range[0] || left.range[1] - right.range[1],
    );
    let furthest = sorted[0];
    for (let index = 1; index < sorted.length; index += 1) {
      const current = sorted[index]!;
      if (
        furthest &&
        current.range[0] <= furthest.range[1] &&
        current.rowIndex !== furthest.rowIndex
      ) {
        return {
          valid: false,
          issue: `${side}-side source ranges overlap between rows[${furthest.rowIndex}] and rows[${current.rowIndex}]`,
        };
      }
      if (!furthest || current.range[1] > furthest.range[1]) furthest = current;
    }
  }

  if (layout.hunkRows.length !== hunkCount) {
    return {
      valid: false,
      issue: `layout has ${layout.hunkRows.length} hunk bounds for ${hunkCount} hunks`,
    };
  }
  const hunkRows: ExtensionFileViewLayout["hunkRows"][number][] = [];
  for (const [position, hunk] of layout.hunkRows.entries()) {
    const startRow = hunk?.startRow;
    const endRow = hunk?.endRow;
    if (
      !hunk ||
      !isRowIndex(startRow, layout.rows.length) ||
      !isRowIndex(endRow, layout.rows.length) ||
      startRow > endRow
    ) {
      return {
        valid: false,
        issue: `hunkRows[${position}] is not an in-bounds row range`,
      };
    }
    hunkRows.push(Object.freeze({ startRow, endRow }));
  }

  const hunkOwnerDeltas = new Int32Array(rows.length + 1);
  for (const hunk of hunkRows) {
    hunkOwnerDeltas[hunk.startRow]! += 1;
    hunkOwnerDeltas[hunk.endRow + 1]! -= 1;
  }
  let hunkOwnerCount = 0;
  for (const [rowIndex, row] of rows.entries()) {
    hunkOwnerCount += hunkOwnerDeltas[rowIndex]!;
    if ((row.sourceRanges?.length ?? 0) > 0 && hunkOwnerCount !== 1) {
      return {
        valid: false,
        issue: `rows[${rowIndex}].sourceRanges must belong to exactly one hunkRows range`,
      };
    }
  }

  const snapshot = Object.freeze({
    rows: Object.freeze(rows),
    hunkRows: Object.freeze(hunkRows),
    ...(codeDocuments.snapshots === undefined ? {} : { codeDocuments: codeDocuments.snapshots }),
  });
  return {
    valid: true,
    value: Object.freeze({ layout: snapshot, rowHeights: Object.freeze(rowHeights) }),
  };
}

/** Count one-based source lines without inventing a line after a trailing newline. */
function exactSourceLineCount(source: string) {
  if (source.length === 0) return 0;
  const withoutTerminator = source.endsWith("\n") ? source.slice(0, -1) : source;
  return withoutTerminator.split("\n").length;
}

/**
 * Why one accepted layout's row bindings could not be verified.
 *
 * `unavailable-source` is an environment condition the host could not resolve; `out-of-bounds` is a
 * binding the extension got wrong. Callers report them differently so attribution stays honest.
 */
export interface FileViewSourceBindingIssue {
  readonly kind: "unavailable-source" | "out-of-bounds";
  readonly detail: string;
}

/** Validate accepted row bindings against the exact source documents the host can read. */
export function validateFileViewSourceRanges(
  layout: ExtensionFileViewLayout,
  documents: Readonly<Partial<Record<ExtensionFileSide, string | null>>>,
): FileViewSourceBindingIssue | null {
  const lineCounts: Partial<Record<ExtensionFileSide, number | null>> = {};
  for (const side of ["old", "new"] as const) {
    const source = documents[side];
    lineCounts[side] = typeof source === "string" ? exactSourceLineCount(source) : null;
  }

  for (const [rowIndex, row] of layout.rows.entries()) {
    for (const [rangeIndex, sourceRange] of (row.sourceRanges ?? []).entries()) {
      const lineCount = lineCounts[sourceRange.side];
      if (lineCount === undefined || lineCount === null) {
        return {
          kind: "unavailable-source",
          detail: `rows[${rowIndex}].sourceRanges[${rangeIndex}] targets unavailable ${sourceRange.side} source`,
        };
      }
      if (sourceRange.range[1] > lineCount) {
        return {
          kind: "out-of-bounds",
          detail: `rows[${rowIndex}].sourceRanges[${rangeIndex}] exceeds the ${sourceRange.side} source bounds`,
        };
      }
    }
  }
  return null;
}

import { sanitizeTerminalLine } from "../../lib/terminalText";
import { measureTextWidth } from "../lib/text";
import { TerminalTextMeasurer } from "../text/measurement";

/** Split terminal-safe complete documents and expand tabs at code-column tab stops. */
export function completeDocumentLines(text: string, tabWidth = 4): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized) return [];
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized)
    .split("\n")
    .map((raw) => {
      const line = sanitizeTerminalLine(raw);
      if (!line.includes("\t")) return line;
      let column = 0;
      return line
        .split("\t")
        .map((segment, index) => {
          const spaces = index ? tabWidth - (column % tabWidth) : 0;
          column += spaces + measureTextWidth(segment);
          return " ".repeat(spaces) + segment;
        })
        .join("");
    });
}

export interface CompleteDocumentGeometry {
  gutter: number;
  width: number;
  rows: readonly { start: number; height: number }[];
  totalHeight: number;
}

/** Measure each logical line once using the same native wrap engine used by file-view rows. */
export function completeDocumentGeometry(
  lines: readonly string[],
  width: number,
  lineNumbers: boolean,
  wrap: boolean,
): CompleteDocumentGeometry {
  const gutter = lineNumbers ? String(Math.max(1, lines.length)).length + 2 : 0;
  const measurer = new TerminalTextMeasurer();
  let totalHeight = 0;
  let contentWidth = Math.max(1, width);
  try {
    const rows = lines.map((line, index) => {
      const text = (lineNumbers ? `${String(index + 1).padStart(gutter - 2)}  ` : "") + line;
      const textWidth = measureTextWidth(text);
      contentWidth = Math.max(contentWidth, textWidth);
      const height = wrap && textWidth > width ? measurer.measure(text, width) : 1;
      const row = { start: totalHeight, height };
      totalHeight += height;
      return row;
    });
    return { gutter, width: wrap ? Math.max(1, width) : contentWidth, rows, totalHeight };
  } finally {
    measurer.destroy();
  }
}

/** Find the logical line containing one physical row without scanning the full document. */
export function completeDocumentLineAt(geometry: CompleteDocumentGeometry, offset: number) {
  let start = 0;
  let end = geometry.rows.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    const row = geometry.rows[middle]!;
    if (row.start + row.height <= offset) start = middle + 1;
    else end = middle;
  }
  return start;
}

export interface CompleteDocumentScrollAnchor {
  line: number;
  offset: number;
}

/** Capture a logical line and its physical offset using the currently mounted geometry. */
export function completeDocumentScrollAnchor(
  geometry: CompleteDocumentGeometry,
  top: number,
): CompleteDocumentScrollAnchor {
  const line = Math.max(
    0,
    Math.min(geometry.rows.length - 1, completeDocumentLineAt(geometry, top)),
  );
  const row = geometry.rows[line];
  return { line, offset: row ? Math.max(0, Math.min(row.height - 1, top - row.start)) : 0 };
}

/** Resolve an anchor to the nearest surviving line and physical row after remeasurement. */
export function completeDocumentScrollAnchorTop(
  geometry: CompleteDocumentGeometry,
  anchor: CompleteDocumentScrollAnchor,
): number {
  const row = geometry.rows[Math.max(0, Math.min(geometry.rows.length - 1, anchor.line))];
  return row ? row.start + Math.min(anchor.offset, row.height - 1) : 0;
}

/** Locate the logical-line window intersecting visible physical rows, including a small halo. */
export function completeDocumentWindow(
  geometry: CompleteDocumentGeometry,
  top: number,
  height: number,
) {
  return {
    start: completeDocumentLineAt(geometry, Math.max(0, top - 5)),
    end: Math.min(geometry.rows.length, completeDocumentLineAt(geometry, top + height + 5) + 1),
  };
}

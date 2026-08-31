import { fitText, measureTextWidth, sliceTextByWidth, wrapText } from "./text";

/** Wrapped body rows that fit one modal body allocation. */
export interface WindowedDialogText {
  lines: string[];
  truncated: boolean;
}

/** Wrap prose to terminal cells, then reserve the final row as an overflow marker. */
export function windowDialogText(
  sourceLines: readonly string[],
  width: number,
  maxRows: number,
): WindowedDialogText {
  const wrapped = sourceLines.flatMap((line) => wrapText(line, width));
  if (wrapped.length <= maxRows) {
    return { lines: wrapped, truncated: false };
  }
  if (maxRows <= 0) {
    return { lines: [], truncated: wrapped.length > 0 };
  }

  return {
    lines: [...wrapped.slice(0, Math.max(0, maxRows - 1)), "…"],
    truncated: true,
  };
}

/** Wrap copyable text by terminal cells without normalizing its whitespace. */
export function windowDialogLiteralText(
  sourceLines: readonly string[],
  width: number,
  maxRows: number,
): WindowedDialogText {
  const safeWidth = Math.max(1, width);
  const wrapped = sourceLines.flatMap((line) => {
    const lineWidth = measureTextWidth(line);
    if (lineWidth === 0) return [line];

    const lines: string[] = [];
    for (let offset = 0; offset < lineWidth; ) {
      const chunk = sliceTextByWidth(line, offset, safeWidth);
      if (chunk.width > 0) {
        lines.push(chunk.text);
        offset += chunk.width;
        continue;
      }

      // A cluster wider than the whole viewport cannot render intact. Show an
      // overflow marker and advance past that cluster instead of looping.
      const wideChunk = sliceTextByWidth(line, offset, safeWidth + 1);
      lines.push(fitText(wideChunk.text, safeWidth, "…"));
      offset += Math.max(1, wideChunk.width);
    }
    return lines;
  });

  if (wrapped.length <= maxRows) return { lines: wrapped, truncated: false };
  if (maxRows <= 0) return { lines: [], truncated: wrapped.length > 0 };
  if (maxRows === 1) {
    return { lines: [fitText(`${wrapped[0] ?? ""}…`, safeWidth, "…")], truncated: true };
  }
  return { lines: [...wrapped.slice(0, maxRows - 1), "…"], truncated: true };
}

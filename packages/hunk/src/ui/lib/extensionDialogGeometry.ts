import { wrapText } from "./text";

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

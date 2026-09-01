import { fitText, measureTextWidth, sliceTextByWidth, wrapText } from "./text";
import { extensionToastPrefix } from "./extensionNotifications";
import { MODAL_FRAME_CHROME_ROWS, resolveModalGeometry } from "./modalGeometry";
import type { ExtensionInfoDialogRequest } from "./extensionDialogs";

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
  let incompleteDisclosure = sourceLines.some((line) =>
    Array.from(line).some((scalar) => measureTextWidth(scalar) === 0),
  );
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
      incompleteDisclosure = true;
      offset += Math.max(1, wideChunk.width);
    }
    return lines;
  });

  if (wrapped.length <= maxRows) return { lines: wrapped, truncated: incompleteDisclosure };
  if (maxRows <= 0) return { lines: [], truncated: wrapped.length > 0 };
  if (maxRows === 1) {
    return { lines: [fitText(`${wrapped[0] ?? ""}…`, safeWidth, "…")], truncated: true };
  }
  return { lines: [...wrapped.slice(0, maxRows - 1), "…"], truncated: true };
}

/** Concrete row allocation shared by info rendering and copy authorization. */
export interface ExtensionInfoDialogLayout {
  frame: { width: number; height: number };
  bodyWidth: number;
  cardWidth: number;
  cardTextWidth: number;
  attributionText: string;
  attributionRows: number;
  attributionGapRows: number;
  bodyCopyGapRows: number;
  copyLabelRows: number;
  copyCardRows: number;
  actionGapRows: number;
  actionRows: number;
  visibleBody: WindowedDialogText;
  visibleCopy: WindowedDialogText;
  /** Whether the complete payload and required attribution are visible beside the action. */
  copyActionExposed: boolean;
}

/** Preserve meaningful text when constrained info has only one body row. */
function windowInfoText(sourceLines: readonly string[], width: number, maxRows: number) {
  const windowed = windowDialogText(sourceLines, width, maxRows);
  if (maxRows !== 1 || !windowed.truncated) return windowed;

  const firstLine = windowDialogText(sourceLines, width, Number.MAX_SAFE_INTEGER).lines[0] ?? "";
  return { lines: [fitText(`${firstLine}…`, width, "…")], truncated: true };
}

/** Plan read-only info so rendering and keyboard copy use identical disclosure facts. */
export function planExtensionInfoDialog(
  request: ExtensionInfoDialogRequest,
  terminalWidth: number,
  terminalHeight: number,
): ExtensionInfoDialogLayout {
  const width = Math.min(84, Math.max(58, terminalWidth - 8));
  const measuredFrame = resolveModalGeometry({
    width,
    height: Number.MAX_SAFE_INTEGER,
    terminalWidth,
    terminalHeight,
  });
  const bodyWidth = Math.max(1, measuredFrame.width - 4);
  const cardWidth = Math.max(1, bodyWidth - 4);
  const cardTextWidth = Math.max(1, cardWidth - 4);
  const availableBodyWidth = measuredFrame.width - 4;
  const availableCardWidth = availableBodyWidth - 4;
  const idealBodyRows = windowDialogText(request.bodyLines, bodyWidth, Number.MAX_SAFE_INTEGER)
    .lines.length;
  const copy = request.copy;
  const idealCopyRows = copy
    ? windowDialogLiteralText(copy.displayLines, cardTextWidth, Number.MAX_SAFE_INTEGER).lines
        .length
    : 0;
  const hasBody = idealBodyRows > 0;
  const hasCopy = copy !== null;
  const idealContentRows =
    (request.showAttribution ? 2 : 0) +
    idealBodyRows +
    (hasBody && hasCopy ? 1 : 0) +
    (hasCopy ? 1 + idealCopyRows + 2 : 0) +
    2;
  const frame = resolveModalGeometry({
    width,
    // The inner flex column lets the final action use the last
    // chrome-adjacent row without adding an empty footer row.
    height: idealContentRows + MODAL_FRAME_CHROME_ROWS - 1,
    terminalWidth,
    terminalHeight,
  });
  const contentRows = Math.max(0, frame.height - MODAL_FRAME_CHROME_ROWS + 1);
  let remainingRows = contentRows;
  // Attribution wins the first available row so third-party copy UI never hides its owner.
  const attributionRows = request.showAttribution && remainingRows > 0 ? 1 : 0;
  remainingRows -= attributionRows;
  const actionRows = remainingRows > 0 ? 1 : 0;
  remainingRows -= actionRows;
  const minimumCopyRows = hasCopy ? 2 : 0;
  const minimumVisibleDocumentRows = (hasBody ? 1 : 0) + minimumCopyRows;
  const attributionGapRows =
    attributionRows > 0 && remainingRows > minimumVisibleDocumentRows ? 1 : 0;
  remainingRows -= attributionGapRows;
  const minimumContentRows = (hasBody ? 1 : 0) + minimumCopyRows;
  const actionGapRows = remainingRows > minimumContentRows ? 1 : 0;
  remainingRows -= actionGapRows;
  const copyReserve = hasCopy ? Math.min(minimumCopyRows, remainingRows) : 0;
  const bodyCopyGapReserve = hasBody && hasCopy && remainingRows > copyReserve + 1 ? 1 : 0;
  const bodyRows = Math.min(
    idealBodyRows,
    Math.max(0, remainingRows - copyReserve - bodyCopyGapReserve),
  );
  remainingRows -= bodyRows;
  const bodyCopyGapRows = bodyRows > 0 && hasCopy && remainingRows > 3 ? 1 : 0;
  remainingRows -= bodyCopyGapRows;
  const copyLabelRows = hasCopy && remainingRows > 1 ? 1 : 0;
  remainingRows -= copyLabelRows;
  const copyCardRows = hasCopy ? remainingRows : 0;
  const visibleBody = windowInfoText(request.bodyLines, bodyWidth, bodyRows);
  const visibleCopy = copy
    ? windowDialogLiteralText(
        copy.displayLines,
        cardTextWidth,
        copyCardRows >= 3 ? copyCardRows - 2 : copyCardRows,
      )
    : { lines: [], truncated: false };
  const fullAttributionText = `${extensionToastPrefix()} ${request.extensionId}`;
  const attributionComplete =
    !request.showAttribution ||
    (attributionRows === 1 && measureTextWidth(fullAttributionText) <= bodyWidth);
  const copyTextHasRealWidth =
    availableBodyWidth > 0 &&
    (copyCardRows >= 3 ? availableCardWidth >= 5 : availableCardWidth >= 1);

  return {
    frame,
    bodyWidth,
    cardWidth,
    cardTextWidth,
    attributionText: fitText(fullAttributionText, bodyWidth),
    attributionRows,
    attributionGapRows,
    bodyCopyGapRows,
    copyLabelRows,
    copyCardRows,
    actionGapRows,
    actionRows,
    visibleBody,
    visibleCopy,
    copyActionExposed:
      hasCopy &&
      actionRows === 1 &&
      copyLabelRows === 1 &&
      copyTextHasRealWidth &&
      !visibleCopy.truncated &&
      attributionComplete,
  };
}

import { fitText, wrapText } from "./text";
import { extensionToastPrefix } from "./extensionNotifications";
import { MODAL_FRAME_CHROME_ROWS, resolveModalGeometry } from "./modalGeometry";
import type { ExtensionOpenDialogRequest } from "./extensionDialogs";

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

/** Concrete host frame and component rectangle for one open dialog. */
export interface ExtensionOpenDialogLayout {
  frame: { width: number; height: number };
  bodyWidth: number;
  componentHeight: number;
  attributionText: string;
  attributionRows: number;
  attributionGapRows: number;
}

/** Clamp an extension-owned component while preserving host attribution above it. */
export function planExtensionOpenDialog(
  request: ExtensionOpenDialogRequest,
  terminalWidth: number,
  terminalHeight: number,
): ExtensionOpenDialogLayout {
  const attributionRequestRows = request.showAttribution ? 2 : 0;
  const frame = resolveModalGeometry({
    width: request.width + 4,
    height: request.height + MODAL_FRAME_CHROME_ROWS + attributionRequestRows,
    terminalWidth,
    terminalHeight,
  });
  const bodyWidth = Math.max(1, frame.width - 4);
  const contentRows = Math.max(0, frame.height - MODAL_FRAME_CHROME_ROWS);
  const attributionRows = request.showAttribution && contentRows > 0 ? 1 : 0;
  const attributionGapRows = attributionRows > 0 && contentRows > 1 ? 1 : 0;
  const componentHeight = Math.max(0, contentRows - attributionRows - attributionGapRows);

  return {
    frame,
    bodyWidth,
    componentHeight,
    attributionText: fitText(`${extensionToastPrefix()} ${request.extensionId}`, bodyWidth),
    attributionRows,
    attributionGapRows,
  };
}

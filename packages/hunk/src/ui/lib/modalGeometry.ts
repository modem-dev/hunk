/** Border, title, and padding rows ModalFrame reserves around its children. */
export const MODAL_FRAME_CHROME_ROWS = 5;

/** Concrete dimensions and placement of a modal inside one terminal viewport. */
export interface ModalGeometry {
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * Clamp requested modal dimensions before either measurement or rendering.
 *
 * Callers use the returned width to wrap content, so their row plans always
 * match the frame ModalFrame eventually draws, including narrow terminals.
 */
export function resolveModalGeometry({
  height,
  terminalHeight,
  terminalWidth,
  width,
}: {
  width: number;
  height: number;
  terminalWidth: number;
  terminalHeight: number;
}): ModalGeometry {
  const availableWidth = Math.max(1, terminalWidth - 2);
  const availableHeight = Math.max(1, terminalHeight - 2);
  const resolvedWidth = Math.max(1, Math.min(width, availableWidth));
  const resolvedHeight = Math.max(1, Math.min(height, availableHeight));

  return {
    width: resolvedWidth,
    height: resolvedHeight,
    left: Math.max(0, Math.floor((terminalWidth - resolvedWidth) / 2)),
    top: Math.max(0, Math.floor((terminalHeight - resolvedHeight) / 2)),
  };
}

import type { CameraTarget, HighlightTarget } from "./plan.mjs";

export interface TerminalFocusProjection {
  translateX: number;
  translateY: number;
  scale: number;
  highlight: { x: number; y: number; width: number; height: number } | null;
}

export function projectTerminalFocus(options: {
  camera?: CameraTarget | null;
  highlight?: HighlightTarget | null;
  sourceHeight: number;
  sourceWidth: number;
  viewportHeight: number;
  viewportWidth: number;
}): TerminalFocusProjection;

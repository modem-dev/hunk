import { MouseButton, type MouseEvent as TuiMouseEvent } from "@opentui/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { resizeSidebarWidth } from "../lib/sidebar";

interface UseSidebarResizeOptions {
  maxWidth: number;
  minWidth: number;
  showPane: boolean;
}

/** Track files-pane width and drag-resize interactions. */
export function useSidebarResize({ maxWidth, minWidth, showPane }: UseSidebarResizeOptions) {
  const [filesPaneWidth, setFilesPaneWidth] = useState(34);
  const [resizeDragOriginX, setResizeDragOriginX] = useState<number | null>(null);
  const [resizeStartWidth, setResizeStartWidth] = useState<number | null>(null);

  const clampedFilesPaneWidth = useMemo(
    () => (showPane ? Math.min(Math.max(filesPaneWidth, minWidth), maxWidth) : 0),
    [filesPaneWidth, maxWidth, minWidth, showPane],
  );
  const isResizingFilesPane = resizeDragOriginX !== null && resizeStartWidth !== null;

  useEffect(() => {
    if (!showPane) {
      setResizeDragOriginX(null);
      setResizeStartWidth(null);
      return;
    }

    setFilesPaneWidth((current) => Math.min(Math.max(current, minWidth), maxWidth));
  }, [maxWidth, minWidth, showPane]);

  const beginFilesPaneResize = useCallback(
    (event: TuiMouseEvent) => {
      if (event.button !== MouseButton.LEFT) {
        return;
      }

      setResizeDragOriginX(event.x);
      setResizeStartWidth(clampedFilesPaneWidth);
      event.preventDefault();
      event.stopPropagation();
    },
    [clampedFilesPaneWidth],
  );

  const updateFilesPaneResize = useCallback(
    (event: TuiMouseEvent) => {
      if (!isResizingFilesPane || resizeDragOriginX === null || resizeStartWidth === null) {
        return;
      }

      setFilesPaneWidth(
        resizeSidebarWidth(resizeStartWidth, resizeDragOriginX, event.x, minWidth, maxWidth),
      );
      event.preventDefault();
      event.stopPropagation();
    },
    [isResizingFilesPane, maxWidth, minWidth, resizeDragOriginX, resizeStartWidth],
  );

  const endFilesPaneResize = useCallback(
    (event?: TuiMouseEvent) => {
      if (!isResizingFilesPane) {
        return;
      }

      setResizeDragOriginX(null);
      setResizeStartWidth(null);
      event?.preventDefault();
      event?.stopPropagation();
    },
    [isResizingFilesPane],
  );

  return {
    beginFilesPaneResize,
    clampedFilesPaneWidth,
    endFilesPaneResize,
    isResizingFilesPane,
    updateFilesPaneResize,
  };
}

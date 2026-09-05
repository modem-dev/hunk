import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { AppTheme } from "../../themes";

const PANE_DIVIDER_HIT_AREA_SIZE = 5;
const PANE_DIVIDER_HIT_AREA_OFFSET = Math.floor(PANE_DIVIDER_HIT_AREA_SIZE / 2);

/** Render a one-cell pane separator, adding a larger pointer target when it is resizable. */
export function PaneDivider({
  orientation,
  width,
  height,
  isActive,
  isResizing,
  resizable,
  theme,
  onMouseDown,
  onMouseDrag,
  onMouseDragEnd,
  onMouseUp,
}: {
  orientation: "vertical" | "horizontal";
  width: number;
  height: number;
  isActive: boolean;
  isResizing: boolean;
  resizable: boolean;
  theme: AppTheme;
  onMouseDown: (event: TuiMouseEvent) => void;
  onMouseDrag: (event: TuiMouseEvent) => void;
  onMouseDragEnd: (event: TuiMouseEvent) => void;
  onMouseUp: (event: TuiMouseEvent) => void;
}) {
  const emphasized = isActive || isResizing;
  const horizontal = emphasized ? "━" : "─";
  const vertical = emphasized ? "┃" : "│";
  const handlers = { onMouseDown, onMouseDrag, onMouseUp, onMouseDragEnd };
  const hitAreaStyle =
    orientation === "vertical"
      ? {
          position: "absolute" as const,
          left: -PANE_DIVIDER_HIT_AREA_OFFSET,
          top: 0,
          width: PANE_DIVIDER_HIT_AREA_SIZE,
          height,
          zIndex: 30,
        }
      : {
          position: "absolute" as const,
          left: 0,
          top: -PANE_DIVIDER_HIT_AREA_OFFSET,
          width,
          height: PANE_DIVIDER_HIT_AREA_SIZE,
          zIndex: 30,
        };
  return (
    <>
      <box
        style={{
          width,
          height,
          flexShrink: 0,
          backgroundColor: isResizing ? theme.accentMuted : theme.panel,
          border: orientation === "vertical" ? ["left"] : ["top"],
          borderColor: emphasized ? theme.accent : theme.border,
        }}
        customBorderChars={{
          topLeft: orientation === "vertical" ? vertical : horizontal,
          topRight: horizontal,
          bottomLeft: vertical,
          bottomRight: horizontal,
          horizontal,
          vertical,
          topT: "┬",
          bottomT: "┴",
          leftT: "├",
          rightT: "┤",
          cross: "┼",
        }}
      />
      {resizable ? <box style={hitAreaStyle} {...handlers} /> : null}
    </>
  );
}

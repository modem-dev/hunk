import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { AppTheme } from "../../themes";

const PANE_DIVIDER_HIT_AREA_SIZE = 5;
const PANE_DIVIDER_HIT_AREA_OFFSET = Math.floor(PANE_DIVIDER_HIT_AREA_SIZE / 2);

/** Render a one-cell pane divider with a larger pointer target on either axis. */
export function PaneDivider({
  orientation,
  width,
  height,
  isResizing,
  theme,
  onMouseDown,
  onMouseDrag,
  onMouseDragEnd,
  onMouseUp,
}: {
  orientation: "vertical" | "horizontal";
  width: number;
  height: number;
  isResizing: boolean;
  theme: AppTheme;
  onMouseDown: (event: TuiMouseEvent) => void;
  onMouseDrag: (event: TuiMouseEvent) => void;
  onMouseDragEnd: (event: TuiMouseEvent) => void;
  onMouseUp: (event: TuiMouseEvent) => void;
}) {
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
          borderColor: isResizing ? theme.accent : theme.border,
        }}
        customBorderChars={{
          topLeft: orientation === "vertical" ? "│" : "─",
          topRight: "─",
          bottomLeft: "│",
          bottomRight: "─",
          horizontal: "─",
          vertical: "│",
          topT: "┬",
          bottomT: "┴",
          leftT: "├",
          rightT: "┤",
          cross: "┼",
        }}
      />
      <box style={hitAreaStyle} {...handlers} />
    </>
  );
}

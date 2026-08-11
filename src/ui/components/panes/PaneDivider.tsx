import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { AppTheme } from "../../themes";

/** Render a one-cell pane divider on either axis. */
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
        {...(orientation === "horizontal" ? handlers : {})}
      />
      {orientation === "vertical" ? (
        <box
          style={{ position: "absolute", left: -2, top: 0, width: 5, height, zIndex: 30 }}
          {...handlers}
        />
      ) : null}
    </>
  );
}

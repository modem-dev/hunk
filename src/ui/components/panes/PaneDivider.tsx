import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { AppTheme } from "../../themes";

/** Render the visible divider plus a wider invisible drag target. */
export function PaneDivider({
  dividerHitLeft,
  dividerHitWidth,
  isResizing,
  theme,
  onMouseDown,
  onMouseDrag,
  onMouseDragEnd,
  onMouseUp,
}: {
  dividerHitLeft: number;
  dividerHitWidth: number;
  isResizing: boolean;
  theme: AppTheme;
  onMouseDown: (event: TuiMouseEvent) => void;
  onMouseDrag: (event: TuiMouseEvent) => void;
  onMouseDragEnd: (event: TuiMouseEvent) => void;
  onMouseUp: (event: TuiMouseEvent) => void;
}) {
  return (
    <>
      <box
        style={{
          width: 1,
          border: ["top", "left"],
          borderColor: isResizing ? theme.accent : theme.border,
          backgroundColor: isResizing ? theme.accentMuted : theme.panel,
        }}
        customBorderChars={{
          topLeft: "┬",
          topRight: "┬",
          bottomLeft: "┴",
          bottomRight: "┴",
          horizontal: "─",
          vertical: "│",
          topT: "┬",
          bottomT: "┴",
          leftT: "├",
          rightT: "┤",
          cross: "┼",
        }}
      />

      <box
        style={{
          position: "absolute",
          top: 1,
          bottom: 1,
          left: dividerHitLeft,
          width: dividerHitWidth,
          zIndex: 30,
        }}
        // The visible divider is only one column wide, so dragging uses a larger hit area.
        onMouseDown={onMouseDown}
        onMouseDrag={onMouseDrag}
        onMouseUp={onMouseUp}
        onMouseDragEnd={onMouseDragEnd}
      />
    </>
  );
}

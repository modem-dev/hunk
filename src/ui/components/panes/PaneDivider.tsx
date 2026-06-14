import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { AppTheme } from "../../themes";

/** Render the visible divider plus a wider invisible drag target. */
export function PaneDivider(props: {
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
          borderColor: props.isResizing ? props.theme.accent : props.theme.border,
          backgroundColor: props.isResizing ? props.theme.accentMuted : props.theme.panel,
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
          left: props.dividerHitLeft,
          width: props.dividerHitWidth,
          zIndex: 30,
        }}
        // The visible divider is only one column wide, so dragging uses a larger hit area.
        onMouseDown={props.onMouseDown}
        onMouseDrag={props.onMouseDrag}
        onMouseUp={props.onMouseUp}
        onMouseDragEnd={props.onMouseDragEnd}
      />
    </>
  );
}

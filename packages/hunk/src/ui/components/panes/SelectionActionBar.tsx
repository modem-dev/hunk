/** Renders the contextual actions for one already-planned diff selection. */
import type { AppTheme } from "../../themes";
import type { SelectionActionBarPlacement } from "./copySelection";

/** Presentation data for the selection action bar. */
export interface SelectionActionBarViewModel {
  bounds: SelectionActionBarPlacement;
  commentEnabled: boolean;
  commentLabel: string;
  copyLabel: string;
}

/** Render selection actions without owning acquisition, geometry, or command policy. */
export function SelectionActionBar({
  model,
  onClear,
  onComment,
  onCopy,
  onPointerActionStart,
  theme,
}: {
  model: SelectionActionBarViewModel;
  onClear: () => void;
  onComment: () => void;
  onCopy: () => void;
  onPointerActionStart: () => void;
  theme: AppTheme;
}) {
  const { bounds } = model;
  return (
    <box
      style={{
        position: "absolute",
        top: bounds.top,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
        flexDirection: "column",
        border: true,
        borderColor: theme.accent,
        backgroundColor: theme.panelAlt,
        zIndex: 20,
      }}
      onMouseDown={(event) => {
        onPointerActionStart();
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseUp={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <box
        style={{
          height: bounds.compact ? 3 : 1,
          flexDirection: bounds.compact ? "column" : "row",
        }}
      >
        <box
          style={{ height: 1 }}
          onMouseDown={(event) => {
            onPointerActionStart();
            event.preventDefault();
            event.stopPropagation();
          }}
          onMouseUp={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onComment();
          }}
        >
          <text fg={model.commentEnabled ? theme.accent : theme.muted}>
            {` ${model.commentLabel} `}
          </text>
        </box>
        <box
          style={{ height: 1 }}
          onMouseDown={(event) => {
            onPointerActionStart();
            event.preventDefault();
            event.stopPropagation();
          }}
          onMouseUp={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCopy();
          }}
        >
          <text fg={theme.text}>{` ${model.copyLabel} `}</text>
        </box>
        <box
          style={{ height: 1 }}
          onMouseDown={(event) => {
            onPointerActionStart();
            event.preventDefault();
            event.stopPropagation();
          }}
          onMouseUp={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClear();
          }}
        >
          <text fg={theme.muted}> Esc Clear </text>
        </box>
      </box>
      {bounds.reasonLines?.map((line, index) => (
        <box
          key={`selection-reason:${index}`}
          style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}
        >
          <text fg={theme.muted}>{line}</text>
        </box>
      ))}
    </box>
  );
}

import type { MouseEvent as TuiMouseEvent } from "@opentui/core";

/** Render one provider revision with Hunk's adjacent click-to-copy action. */
export function RevisionIdControl({
  displayRevision,
  revisionColor,
  copyColor,
  copyIcon = "⧉",
  onRevisionClick,
  onShiftClick,
  onCopy,
}: {
  displayRevision: string;
  revisionColor: string;
  copyColor: string;
  copyIcon?: string;
  onRevisionClick?: () => void;
  onShiftClick?: () => void;
  onCopy: () => void;
}) {
  const activate = (event: TuiMouseEvent, action: () => void) => {
    event.stopPropagation();
    if (event.modifiers.shift && onShiftClick) onShiftClick();
    else action();
  };
  return (
    <box
      style={{ flexDirection: "row", gap: 1 }}
      onMouseUp={(event: TuiMouseEvent) => activate(event, onCopy)}
    >
      <text
        fg={revisionColor}
        onMouseUp={(event: TuiMouseEvent) => {
          activate(event, onRevisionClick ?? onCopy);
        }}
      >
        {displayRevision}
      </text>
      <text
        fg={copyColor}
        onMouseUp={(event: TuiMouseEvent) => {
          activate(event, onCopy);
        }}
      >
        {copyIcon}
      </text>
    </box>
  );
}

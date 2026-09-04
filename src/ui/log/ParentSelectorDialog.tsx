import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { fitText } from "../lib/text";
import type { AppTheme } from "../themes";
import { ModalFrame } from "../components/chrome/ModalFrame";

/** Let a caller choose one ordered opaque parent without interpreting provider syntax. */
export function ParentSelectorDialog({
  parentRevisionIds,
  selectedIndex,
  terminalHeight,
  terminalWidth,
  theme,
  onAccept,
  onClose,
  onSelect,
}: {
  parentRevisionIds: readonly string[];
  selectedIndex: number;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onAccept: (index: number) => void;
  onClose: () => void;
  onSelect: (index: number) => void;
}) {
  const width = Math.max(1, Math.min(70, terminalWidth - 2));
  // Borders, title padding, help row, and bottom padding consume six rows.
  const height = Math.max(1, Math.min(parentRevisionIds.length + 6, terminalHeight - 2));
  const bodyWidth = Math.max(1, width - 4);
  const visibleRows = Math.max(1, height - 6);
  const start = Math.max(
    0,
    Math.min(parentRevisionIds.length - visibleRows, selectedIndex - Math.floor(visibleRows / 2)),
  );
  return (
    <ModalFrame
      height={height}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Compare with parent"
      width={width}
      onClose={onClose}
      onMouseScroll={(event) => {
        const direction = event.scroll?.direction;
        if (direction === "up") onSelect(Math.max(0, selectedIndex - 1));
        else if (direction === "down")
          onSelect(Math.min(parentRevisionIds.length - 1, selectedIndex + 1));
      }}
    >
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.muted}>{fitText("Enter/click open · Esc cancel", bodyWidth)}</text>
      </box>
      {parentRevisionIds.slice(start, start + visibleRows).map((parentId, offset) => {
        const index = start + offset;
        const selected = index === selectedIndex;
        return (
          <box
            key={parentId}
            style={{
              width: "100%",
              height: 1,
              backgroundColor: selected ? theme.accentMuted : theme.panel,
            }}
            onMouseOver={() => onSelect(index)}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              onAccept(index);
            }}
          >
            <text fg={selected ? theme.text : theme.muted}>
              {fitText(`${index + 1}. ${parentId}`, bodyWidth)}
            </text>
          </box>
        );
      })}
    </ModalFrame>
  );
}

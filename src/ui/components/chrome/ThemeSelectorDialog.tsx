import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

export interface ThemeSelectorItem {
  id: string;
  label: string;
  description: string;
  active: boolean;
}

/** Keep the selected row visible in the fixed-height theme selector list. */
function visibleWindowStart(selectedIndex: number, rowCount: number, visibleRows: number) {
  if (rowCount <= visibleRows) {
    return 0;
  }

  const centered = selectedIndex - Math.floor(visibleRows / 2);
  return Math.min(Math.max(centered, 0), rowCount - visibleRows);
}

/** Render an opencode-style selector for Hunk themes. */
export function ThemeSelectorDialog({
  items,
  selectedIndex,
  terminalHeight,
  terminalWidth,
  theme,
  onClose,
  onHoverItem,
  onSelectItem,
}: {
  items: ThemeSelectorItem[];
  selectedIndex: number;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onClose: () => void;
  onHoverItem: (index: number) => void;
  onSelectItem: (item: ThemeSelectorItem) => void;
}) {
  const width = Math.min(82, Math.max(56, terminalWidth - 8));
  const modalHeight = Math.min(Math.max(12, terminalHeight - 4), 28);
  const bodyWidth = Math.max(1, width - 4);
  // ModalFrame contributes border/title/padding; reserve help/footer rows inside the body.
  const visibleRows = Math.max(4, modalHeight - 7);
  const start = visibleWindowStart(selectedIndex, items.length, visibleRows);
  const visibleItems = items.slice(start, start + visibleRows);
  const markerWidth = 3;
  const descriptionWidth = 12;
  const labelWidth = Math.max(8, bodyWidth - markerWidth - descriptionWidth - 2);

  return (
    <ModalFrame
      height={modalHeight}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Theme selector"
      width={width}
      onClose={onClose}
    >
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.muted}>
          {fitText("↑/↓/Tab preview  Enter select  Esc cancel", bodyWidth)}
        </text>
      </box>
      <box style={{ width: "100%", height: 1 }} />
      {visibleItems.map((item, offset) => {
        const index = start + offset;
        const selected = index === selectedIndex;
        const marker = selected ? "›" : item.active ? "✓" : " ";
        const bg = selected ? theme.accentMuted : theme.panel;
        const fg = selected ? theme.text : item.active ? theme.badgeNeutral : theme.muted;

        return (
          <box
            key={item.id}
            style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: bg }}
            // Use movement, not enter/over, so palette preview rerenders do not reselect the row
            // currently under a stationary mouse while the user navigates with the keyboard.
            onMouseMove={() => onHoverItem(index)}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              onSelectItem(item);
            }}
          >
            <text fg={fg}>{padText(marker, markerWidth)}</text>
            <text fg={fg}>{padText(fitText(item.label, labelWidth), labelWidth)}</text>
            <text fg={theme.muted}>{fitText(item.description, descriptionWidth)}</text>
          </box>
        );
      })}
      {start + visibleRows < items.length ? (
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.muted}>
            {fitText(`… ${items.length - start - visibleRows} more`, bodyWidth)}
          </text>
        </box>
      ) : null}
    </ModalFrame>
  );
}

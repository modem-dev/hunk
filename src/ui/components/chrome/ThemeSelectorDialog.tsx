import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { listWindowStart } from "../../lib/listWindow";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

export interface ThemeSelectorItem {
  id: string;
  label: string;
  description: string;
  active: boolean;
}

const THEME_HOVER_PREVIEW_DELAY_MS = 200;

/** Render an opencode-style selector for Hunk themes. */
export function ThemeSelectorDialog({
  items,
  selectedIndex,
  terminalHeight,
  terminalWidth,
  theme,
  onAcceptItem,
  onClose,
  onPreviewItem,
}: {
  items: ThemeSelectorItem[];
  selectedIndex: number;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onAcceptItem: (index: number) => void;
  onClose: () => void;
  onPreviewItem: (index: number) => void;
}) {
  const width = Math.min(82, Math.max(56, terminalWidth - 8));
  const modalHeight = Math.min(Math.max(12, terminalHeight - 4), 28);
  const bodyWidth = Math.max(1, width - 4);
  // ModalFrame contributes border/title/padding; reserve help/footer rows inside the body.
  const visibleRows = Math.max(4, modalHeight - 7);
  const [windowStart, setWindowStart] = useState(() =>
    listWindowStart(selectedIndex, items.length, visibleRows),
  );
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxWindowStart = Math.max(0, items.length - visibleRows);

  /** Cancel a hover preview that has not reached its dwell threshold. */
  const cancelPendingPreview = () => {
    if (previewTimeoutRef.current !== null) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
  };

  /** Preview a theme only after the pointer remains over its row. */
  const schedulePreview = (index: number) => {
    cancelPendingPreview();
    previewTimeoutRef.current = setTimeout(() => {
      previewTimeoutRef.current = null;
      onPreviewItem(index);
    }, THEME_HOVER_PREVIEW_DELAY_MS);
  };

  // Keyboard selection changes keep their row visible and supersede pending pointer previews,
  // while mouse-wheel scrolling can move the window without changing the current preview.
  useEffect(() => {
    cancelPendingPreview();
    setWindowStart((current) => {
      const clamped = Math.min(Math.max(current, 0), maxWindowStart);
      if (selectedIndex < clamped) {
        return Math.max(0, selectedIndex);
      }
      if (selectedIndex >= clamped + visibleRows) {
        return Math.min(maxWindowStart, selectedIndex - visibleRows + 1);
      }
      return clamped;
    });
  }, [maxWindowStart, selectedIndex, visibleRows]);

  useEffect(
    () => () => {
      cancelPendingPreview();
    },
    [],
  );

  const visibleItems = items.slice(windowStart, windowStart + visibleRows);
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
      onMouseScroll={(event) => {
        cancelPendingPreview();
        const direction = event.scroll?.direction;
        if (direction === "up") {
          setWindowStart((current) => Math.max(0, current - 1));
        } else if (direction === "down") {
          setWindowStart((current) => Math.min(maxWindowStart, current + 1));
        }
      }}
    >
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.muted}>{fitText("Enter/click accept  Esc cancel", bodyWidth)}</text>
      </box>
      <box style={{ width: "100%", height: 1 }} />
      {visibleItems.map((item, offset) => {
        const index = windowStart + offset;
        const selected = index === selectedIndex;
        const marker = selected ? "›" : item.active ? "✓" : " ";
        const bg = selected ? theme.accentMuted : theme.panel;
        const fg = selected ? theme.text : item.active ? theme.badgeNeutral : theme.muted;

        return (
          <box
            key={item.id}
            style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: bg }}
            onMouseOut={cancelPendingPreview}
            onMouseOver={() => schedulePreview(index)}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              cancelPendingPreview();
              onAcceptItem(index);
            }}
          >
            <text fg={fg}>{padText(marker, markerWidth)}</text>
            <text fg={fg}>{padText(fitText(item.label, labelWidth), labelWidth)}</text>
            <text fg={theme.muted}>{fitText(item.description, descriptionWidth)}</text>
          </box>
        );
      })}
      {windowStart + visibleRows < items.length ? (
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.muted}>
            {fitText(`… ${items.length - windowStart - visibleRows} more`, bodyWidth)}
          </text>
        </box>
      ) : null}
    </ModalFrame>
  );
}

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

interface ThemeSelectorWindowState {
  itemCount: number;
  selectedIndex: number;
  visibleRows: number;
  windowStart: number;
}

/** Keep the selected theme visible when selector geometry or selection changes. */
function synchronizeThemeSelectorWindow(
  current: ThemeSelectorWindowState,
  selectedIndex: number,
  itemCount: number,
  visibleRows: number,
): ThemeSelectorWindowState {
  if (
    current.selectedIndex === selectedIndex &&
    current.itemCount === itemCount &&
    current.visibleRows === visibleRows
  ) {
    return current;
  }

  const maxWindowStart = Math.max(0, itemCount - visibleRows);
  const clamped = Math.min(Math.max(current.windowStart, 0), maxWindowStart);
  const windowStart =
    selectedIndex < clamped
      ? Math.max(0, selectedIndex)
      : selectedIndex >= clamped + visibleRows
        ? Math.min(maxWindowStart, selectedIndex - visibleRows + 1)
        : clamped;

  return { itemCount, selectedIndex, visibleRows, windowStart };
}

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
  const width = Math.max(1, Math.min(82, Math.max(56, terminalWidth - 8), terminalWidth - 2));
  const modalHeight = Math.max(
    1,
    Math.min(28, Math.max(12, terminalHeight - 4), terminalHeight - 2),
  );
  const bodyWidth = Math.max(1, width - 4);
  // ModalFrame contributes border/title/padding; reserve help/footer rows inside the body.
  const visibleRows = Math.max(
    1,
    Math.min(Math.max(4, modalHeight - 7), Math.max(1, modalHeight - 5)),
  );
  const [windowState, setWindowState] = useState<ThemeSelectorWindowState>(() => ({
    itemCount: items.length,
    selectedIndex,
    visibleRows,
    windowStart: listWindowStart(selectedIndex, items.length, visibleRows),
  }));
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxWindowStart = Math.max(0, items.length - visibleRows);
  const synchronizedWindowState = synchronizeThemeSelectorWindow(
    windowState,
    selectedIndex,
    items.length,
    visibleRows,
  );

  // Adjust during render so the selected row cannot paint outside a stale window. React restarts
  // this component immediately, avoiding the passive-effect update loop that rapid key repeat hit.
  if (synchronizedWindowState !== windowState) {
    setWindowState(synchronizedWindowState);
  }
  const windowStart = synchronizedWindowState.windowStart;

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

  // Selection, catalog, or geometry changes supersede a pointer dwell without another render.
  useEffect(cancelPendingPreview, [items, selectedIndex, visibleRows]);

  useEffect(
    () => () => {
      cancelPendingPreview();
    },
    [],
  );

  const visibleItems = items.slice(windowStart, windowStart + visibleRows);
  const markerWidth = Math.min(3, bodyWidth);
  const descriptionWidth = bodyWidth >= 28 ? 12 : 0;
  const labelWidth = Math.max(
    0,
    bodyWidth - markerWidth - descriptionWidth - (descriptionWidth ? 2 : 0),
  );

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
          setWindowState((current) => {
            const synchronized = synchronizeThemeSelectorWindow(
              current,
              selectedIndex,
              items.length,
              visibleRows,
            );
            const windowStart = Math.max(0, synchronized.windowStart - 1);
            return windowStart === synchronized.windowStart
              ? synchronized
              : { ...synchronized, windowStart };
          });
        } else if (direction === "down") {
          setWindowState((current) => {
            const synchronized = synchronizeThemeSelectorWindow(
              current,
              selectedIndex,
              items.length,
              visibleRows,
            );
            const windowStart = Math.min(maxWindowStart, synchronized.windowStart + 1);
            return windowStart === synchronized.windowStart
              ? synchronized
              : { ...synchronized, windowStart };
          });
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

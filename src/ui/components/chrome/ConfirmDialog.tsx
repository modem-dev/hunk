import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { ReactNode } from "react";
import { useState } from "react";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

/** One confirm choice: its footer key legend, label, and the action it runs. */
export interface ConfirmDialogAction {
  /** Keyboard legend shown in the footer, e.g. "enter/s", "d", "esc". */
  keyLabel: string;
  /** Short lowercase verb phrase, e.g. "save" or "never ask". */
  label: string;
  /** Run the choice. Invoked on mouse click; keyboard routing stays with the caller. */
  run: () => void;
}

/** Rows ConfirmDialog adds around the body: ModalFrame chrome plus spacer and action row. */
const CONFIRM_DIALOG_CHROME_ROWS = 7;

/** Modal height for a ConfirmDialog whose body renders the given number of rows. */
export function confirmDialogHeight(bodyRows: number) {
  return bodyRows + CONFIRM_DIALOG_CHROME_ROWS;
}

/**
 * Hunk's standard confirm modal shape: a ModalFrame with arbitrary body rows and
 * one bottom action legend (`key label · key label · …`).
 *
 * Actions are mouse-clickable and highlight on hover. Keyboard shortcuts for the
 * same actions are intentionally not handled here — wire them through
 * useAppKeyboardShortcuts so all key handling stays in one place, and keep each
 * action's `keyLabel` in sync with the keys that hook accepts.
 *
 * New confirmation prompts should reuse this component instead of composing
 * ModalFrame with a hand-rolled footer. Size it with
 * `confirmDialogHeight(bodyRows)` where `bodyRows` counts the 1-row boxes the
 * body renders.
 */
export function ConfirmDialog({
  actions,
  children,
  height,
  onClose,
  terminalHeight,
  terminalWidth,
  theme,
  title,
  width,
}: {
  actions: ConfirmDialogAction[];
  children: ReactNode;
  height: number;
  /** Invoked by the frame's backdrop click and [Esc] affordance. */
  onClose?: () => void;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  title: string;
  width: number;
}) {
  const [hoveredActionKey, setHoveredActionKey] = useState<string | null>(null);

  return (
    <ModalFrame
      height={height}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={title}
      width={width}
      onClose={onClose}
    >
      {children}
      <box style={{ width: "100%", height: 1 }} />
      <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
        {actions.map((action, index) => {
          const hovered = hoveredActionKey === action.keyLabel;
          return (
            <box key={action.keyLabel} style={{ flexDirection: "row" }}>
              {index > 0 ? <text fg={theme.badgeNeutral}> · </text> : null}
              <box
                style={{
                  flexDirection: "row",
                  paddingLeft: 1,
                  paddingRight: 1,
                  backgroundColor: hovered ? theme.accentMuted : undefined,
                }}
                onMouseOver={() => setHoveredActionKey(action.keyLabel)}
                onMouseOut={() =>
                  setHoveredActionKey((current) => (current === action.keyLabel ? null : current))
                }
                onMouseUp={(event: TuiMouseEvent) => {
                  event.stopPropagation();
                  action.run();
                }}
              >
                <text fg={theme.accent}>{action.keyLabel}</text>
                <text fg={hovered ? theme.text : theme.muted}> {action.label}</text>
              </box>
            </box>
          );
        })}
      </box>
    </ModalFrame>
  );
}

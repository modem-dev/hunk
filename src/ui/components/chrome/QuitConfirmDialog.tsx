import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

/** Confirm before leaving a review that has comments or notes in memory. */
export function QuitConfirmDialog({
  terminalHeight,
  terminalWidth,
  theme,
  onCancel,
  onConfirm,
}: {
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const width = Math.min(68, Math.max(48, terminalWidth - 8));
  const bodyWidth = Math.max(1, width - 4);
  const modalHeight = Math.min(10, Math.max(8, terminalHeight - 2));
  const stayLabel = " Stay ";
  const quitLabel = " Quit ";

  return (
    <ModalFrame
      height={modalHeight}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Quit review?"
      width={width}
      onClose={onCancel}
    >
      <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.text}>
            {fitText("This review has comments or notes that will be lost.", bodyWidth)}
          </text>
        </box>
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.muted}>
            {fitText("Press Enter or y to quit, Esc or n to stay.", bodyWidth)}
          </text>
        </box>
        <box style={{ width: "100%", height: 1 }} />
        <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
          <box
            style={{ backgroundColor: theme.panelAlt }}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              onCancel();
            }}
          >
            <text fg={theme.text}>{stayLabel}</text>
          </box>
          <text fg={theme.muted}>
            {padText("", Math.max(1, bodyWidth - stayLabel.length - quitLabel.length - 1))}
          </text>
          <box
            style={{ backgroundColor: theme.accentMuted }}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              onConfirm();
            }}
          >
            <text fg={theme.text}>{quitLabel}</text>
          </box>
        </box>
      </box>
    </ModalFrame>
  );
}

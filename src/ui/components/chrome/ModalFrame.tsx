import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { ReactNode } from "react";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

/** Render a centered framed modal container that other dialogs can reuse. */
export function ModalFrame({
  children,
  height,
  onClose,
  terminalHeight,
  terminalWidth,
  theme,
  title,
  width,
}: {
  children: ReactNode;
  height: number;
  onClose?: () => void;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  title: string;
  width: number;
}) {
  const clampedWidth = Math.min(width, Math.max(24, terminalWidth - 2));
  const clampedHeight = Math.min(height, Math.max(5, terminalHeight - 2));
  const left = Math.max(1, Math.floor((terminalWidth - clampedWidth) / 2));
  const top = Math.max(1, Math.floor((terminalHeight - clampedHeight) / 2));
  const closeText = onClose ? "[Esc]" : "";
  const titleWidth = Math.max(1, clampedWidth - 2 - (closeText ? closeText.length + 1 : 0));

  return (
    <>
      <box
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: terminalWidth,
          height: terminalHeight,
          zIndex: 55,
        }}
        onMouseUp={onClose}
      />
      <box
        style={{
          position: "absolute",
          top,
          left,
          width: clampedWidth,
          height: clampedHeight,
          zIndex: 60,
          border: true,
          borderColor: theme.accent,
          backgroundColor: theme.panel,
          flexDirection: "column",
        }}
        onMouseUp={(event: TuiMouseEvent) => event.stopPropagation()}
      >
        <box
          style={{
            paddingLeft: 1,
            paddingRight: 1,
            paddingTop: 1,
            flexDirection: "row",
          }}
        >
          <text fg={theme.text}>{padText(fitText(title, titleWidth), titleWidth)}</text>
          {closeText ? (
            <box
              onMouseUp={(event: TuiMouseEvent) => {
                event.stopPropagation();
                onClose?.();
              }}
            >
              <text fg={theme.badgeNeutral}>{closeText}</text>
            </box>
          ) : null}
        </box>
        <box
          style={{
            paddingLeft: 1,
            paddingRight: 1,
            paddingBottom: 1,
            flexDirection: "column",
            flexGrow: 1,
          }}
        >
          {children}
        </box>
      </box>
    </>
  );
}

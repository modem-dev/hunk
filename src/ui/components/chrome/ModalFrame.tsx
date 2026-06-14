import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

/** Render a centered framed modal container that other dialogs can reuse. */
export function ModalFrame(props: {
  children: JSX.Element;
  height: number;
  onClose?: () => void;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  title: string;
  width: number;
}) {
  const clampedWidth = Math.min(props.width, Math.max(24, props.terminalWidth - 2));
  const clampedHeight = Math.min(props.height, Math.max(5, props.terminalHeight - 2));
  const left = Math.max(1, Math.floor((props.terminalWidth - clampedWidth) / 2));
  const top = Math.max(1, Math.floor((props.terminalHeight - clampedHeight) / 2));
  const closeText = props.onClose ? "[Esc]" : "";
  const titleWidth = Math.max(1, clampedWidth - 2 - (closeText ? closeText.length + 1 : 0));

  return (
    <>
      <box
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: props.terminalWidth,
          height: props.terminalHeight,
          zIndex: 55,
        }}
        onMouseUp={props.onClose}
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
          borderColor: props.theme.accent,
          backgroundColor: props.theme.panel,
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
          <text fg={props.theme.text}>{padText(fitText(props.title, titleWidth), titleWidth)}</text>
          <Show when={closeText}>
            <box
              onMouseUp={(event: TuiMouseEvent) => {
                event.stopPropagation();
                props.onClose?.();
              }}
            >
              <text fg={props.theme.badgeNeutral}>{closeText}</text>
            </box>
          </Show>
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
          {props.children}
        </box>
      </box>
    </>
  );
}

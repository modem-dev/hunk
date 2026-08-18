import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import stringWidth from "string-width";
import { isEscapeKey } from "../../lib/keyboard";
import type { AppTheme } from "../../themes";

/** One focused prompt input rendered inline in the status bar (file filter, goto line). */
export interface StatusBarPromptInput {
  label: string;
  value: string;
  placeholder?: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onEscape: () => void;
}

/** Render the active prompt input, active file filter, transient notice, and mode badge. */
export function StatusBar({
  filter,
  promptInput,
  modeText,
  noticeText,
  terminalWidth,
  theme,
  onCloseMenu,
  onExitMode,
}: {
  filter: string;
  promptInput?: StatusBarPromptInput | null;
  modeText?: string;
  noticeText?: string;
  terminalWidth: number;
  theme: AppTheme;
  onCloseMenu: () => void;
  onExitMode?: () => void;
}) {
  const modeWidth = modeText
    ? Math.min(stringWidth(modeText) + 2, Math.max(6, Math.floor(terminalWidth / 2)))
    : 0;

  return (
    <box
      style={{
        height: 1,
        backgroundColor: theme.panelAlt,
        paddingLeft: 1,
        paddingRight: 1,
        alignItems: "center",
        flexDirection: "row",
      }}
      onMouseUp={onCloseMenu}
    >
      <box
        style={{
          height: 1,
          flexGrow: 1,
          overflow: "hidden",
          alignItems: "center",
          flexDirection: "row",
        }}
      >
        {promptInput ? (
          <>
            <text fg={theme.badgeNeutral}>{promptInput.label}</text>
            <box style={{ width: 1, height: 1 }}>
              <text fg={theme.muted}> </text>
            </box>
            <input
              width={Math.max(4, terminalWidth - modeWidth - promptInput.label.length - 9)}
              value={promptInput.value}
              placeholder={promptInput.placeholder}
              focused={true}
              onInput={promptInput.onInput}
              onSubmit={promptInput.onSubmit}
              onKeyDown={(key) => {
                if (!isEscapeKey(key)) {
                  return;
                }

                key.preventDefault();
                key.stopPropagation();
                promptInput.onEscape();
              }}
            />
          </>
        ) : noticeText ? (
          <text fg={theme.muted}>{noticeText}</text>
        ) : filter.length > 0 ? (
          <text fg={theme.muted}>{`filter=${filter}`}</text>
        ) : (
          <text fg={theme.muted}>{""}</text>
        )}
      </box>
      {modeText ? (
        <box
          style={{
            height: 1,
            width: modeWidth,
            overflow: "hidden",
            backgroundColor: theme.badgeNeutral,
          }}
          onMouseUp={(event: TuiMouseEvent) => {
            event.stopPropagation();
            onExitMode?.();
          }}
        >
          <text fg={theme.panelAlt}>{` ${modeText} `}</text>
        </box>
      ) : null}
    </box>
  );
}

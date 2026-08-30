import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import stringWidth from "string-width";
import { isEscapeKey } from "../../lib/keyboard";
import type { AppTheme } from "../../themes";

/** Render the active file filter, transient notice, and persistent keyboard-mode badge. */
export function StatusBar({
  filter,
  filterFocused,
  modeText,
  noticeText,
  terminalWidth,
  theme,
  onCloseMenu,
  onFilterInput,
  onFilterSubmit,
  onExitMode,
}: {
  filter: string;
  filterFocused: boolean;
  modeText?: string;
  noticeText?: string;
  terminalWidth: number;
  theme: AppTheme;
  onCloseMenu: () => void;
  onFilterInput: (value: string) => void;
  onFilterSubmit: () => void;
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
        {filterFocused ? (
          <>
            <text fg={theme.badgeNeutral}>filter:</text>
            <box style={{ width: 1, height: 1 }}>
              <text fg={theme.muted}> </text>
            </box>
            <input
              width={Math.max(4, terminalWidth - modeWidth - 11)}
              value={filter}
              placeholder="type to filter files"
              focused={true}
              onInput={onFilterInput}
              onSubmit={onFilterSubmit}
              onKeyDown={(key) => {
                if (!isEscapeKey(key)) {
                  return;
                }

                key.preventDefault();
                key.stopPropagation();

                if (filter.length > 0) {
                  onFilterInput("");
                  return;
                }

                onFilterSubmit();
              }}
            />
          </>
        ) : filter.length > 0 ? (
          <text fg={theme.muted}>{`filter=${filter}`}</text>
        ) : (
          <text fg={theme.muted}>{noticeText ?? ""}</text>
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

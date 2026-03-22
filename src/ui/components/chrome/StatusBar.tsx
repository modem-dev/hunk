import type { AppTheme } from "../../themes";
import { fitText } from "../../lib/text";

/** Render either keyboard hints or the active file filter input. */
export function StatusBar({
  canResizeDivider = false,
  filter,
  filterFocused,
  terminalWidth,
  theme,
  onCloseMenu,
  onFilterInput,
  onFilterSubmit,
}: {
  canResizeDivider?: boolean;
  filter: string;
  filterFocused: boolean;
  terminalWidth: number;
  theme: AppTheme;
  onCloseMenu: () => void;
  onFilterInput: (value: string) => void;
  onFilterSubmit: () => void;
}) {
  const hintParts = ["F10 menu"];
  if (canResizeDivider) {
    hintParts.push("drag divider resize");
  }
  hintParts.push(
    "↑↓ line",
    "space/b page",
    "/ filter",
    "[ ] hunk nav",
    "1 2 0 layout",
    "s sidebar",
    "t theme",
    "a notes",
    "l lines",
    "w wrap",
    "m meta",
    "q quit",
  );

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
      {filterFocused ? (
        <>
          <text fg={theme.badgeNeutral}>filter:</text>
          <box style={{ width: 1, height: 1 }}>
            <text fg={theme.muted}> </text>
          </box>
          <input
            width={Math.max(12, terminalWidth - 11)}
            value={filter}
            placeholder="type to filter files"
            focused={true}
            onInput={onFilterInput}
            onSubmit={onFilterSubmit}
          />
        </>
      ) : (
        <text fg={theme.muted}>
          {fitText(
            `${hintParts.join("  ")}${filter ? `  filter=${filter}` : ""}`,
            terminalWidth - 2,
          )}
        </text>
      )}
    </box>
  );
}

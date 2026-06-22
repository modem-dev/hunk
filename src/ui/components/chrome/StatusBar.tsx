import { isEscapeKey } from "../../lib/keyboard";
import type { AppTheme } from "../../themes";

/** Render the active file filter input, in-diff search input, or a passive summary. */
export function StatusBar({
  filter,
  filterFocused,
  searchQuery,
  searchInputDraft,
  searchFocused,
  searchMatchCount = 0,
  searchMatchIndex = -1,
  noticeText,
  terminalWidth,
  theme,
  onCloseMenu,
  onFilterInput,
  onFilterSubmit,
  onSearchInput,
  onSearchSubmit,
}: {
  filter: string;
  filterFocused: boolean;
  searchQuery: string;
  searchInputDraft: string;
  searchFocused: boolean;
  searchMatchCount?: number;
  searchMatchIndex?: number;
  noticeText?: string;
  terminalWidth: number;
  theme: AppTheme;
  onCloseMenu: () => void;
  onFilterInput: (value: string) => void;
  onFilterSubmit: () => void;
  onSearchInput: (value: string) => void;
  onSearchSubmit: () => void;
}) {
  const searchSummary =
    searchQuery.length > 0
      ? searchMatchCount > 0
        ? `search=${searchQuery} (${searchMatchIndex + 1}/${searchMatchCount})`
        : `search=${searchQuery} (no matches)`
      : "";
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
      {searchFocused ? (
        <>
          <text fg={theme.badgeNeutral}>search:</text>
          <box style={{ width: 1, height: 1 }}>
            <text fg={theme.muted}> </text>
          </box>
          <input
            width={Math.max(12, terminalWidth - 11)}
            value={searchInputDraft}
            placeholder="type to search diff content"
            focused={true}
            onInput={onSearchInput}
            onSubmit={onSearchSubmit}
            onKeyDown={(key) => {
              if (!isEscapeKey(key)) {
                return;
              }

              key.preventDefault();
              key.stopPropagation();

              if (searchInputDraft.length > 0) {
                onSearchInput("");
                return;
              }

              onSearchSubmit();
            }}
          />
        </>
      ) : filterFocused ? (
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
      ) : searchSummary.length > 0 ? (
        <text fg={theme.muted}>{searchSummary}</text>
      ) : filter.length > 0 ? (
        <text fg={theme.muted}>{`filter=${filter}`}</text>
      ) : (
        <text fg={theme.muted}>{noticeText ?? ""}</text>
      )}
    </box>
  );
}

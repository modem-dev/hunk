import { For, mergeProps, Show } from "solid-js";
import { fileRowId } from "../../lib/ids";
import { sidebarEntryStats, type FileGroupEntry, type FileListEntry } from "../../lib/files";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

/** Get icon and color for file state using standard git status codes. */
function getFileStateIcon(entry: FileListEntry, theme: AppTheme): { icon: string; color: string } {
  if (entry.isUntracked) {
    return { icon: "?", color: theme.fileUntracked };
  }

  switch (entry.changeType) {
    case "new":
      return { icon: "A", color: theme.fileNew };
    case "deleted":
      return { icon: "D", color: theme.fileDeleted };
    case "rename-pure":
    case "rename-changed":
      return { icon: "R", color: theme.fileRenamed };
    case "change":
      return { icon: "M", color: theme.fileModified };
    default:
      return { icon: "", color: theme.text };
  }
}

/** Render one folder header in the navigation sidebar. */
export function FileGroupHeader(props: {
  entry: FileGroupEntry;
  paddingLeft?: number;
  textWidth: number;
  theme: AppTheme;
}) {
  const merged = mergeProps({ paddingLeft: 1 }, props);
  return (
    <box
      style={{
        width: "100%",
        height: 1,
        paddingLeft: merged.paddingLeft,
        backgroundColor: merged.theme.panel,
      }}
    >
      <text fg={merged.theme.muted}>
        {fitText(merged.entry.label, Math.max(1, merged.textWidth))}
      </text>
    </box>
  );
}

/** Render one file row in the navigation sidebar. */
export function FileListItem(props: {
  entry: FileListEntry;
  paddingLeft?: number;
  selected: boolean;
  statsWidth: number;
  textWidth: number;
  theme: AppTheme;
  onSelectFile: (fileId: string) => void;
}) {
  const merged = mergeProps({ paddingLeft: 1 }, props);
  const rowBackground = () => (merged.selected ? merged.theme.panelAlt : merged.theme.panel);
  const stats = () => sidebarEntryStats(merged.entry);
  const stateIcon = () => getFileStateIcon(merged.entry, merged.theme);
  const iconWidth = () => (stateIcon().icon ? 2 : 0); // icon + space
  const statsSectionWidth = () => (merged.statsWidth > 0 ? merged.statsWidth + 1 : 0);
  const nameWidth = () => Math.max(1, merged.textWidth - 1 - iconWidth() - statsSectionWidth());

  return (
    <box
      id={fileRowId(merged.entry.id)}
      style={{
        width: "100%",
        height: 1,
        backgroundColor: rowBackground(),
        flexDirection: "row",
      }}
      onMouseUp={() => merged.onSelectFile(merged.entry.id)}
    >
      <box
        style={{
          width: 1,
          height: 1,
          backgroundColor: merged.selected ? merged.theme.accent : rowBackground(),
        }}
      />
      <box
        style={{
          flexGrow: 1,
          height: 1,
          paddingLeft: merged.paddingLeft,
          flexDirection: "row",
          backgroundColor: rowBackground(),
        }}
      >
        <Show when={stateIcon().icon}>
          <text fg={stateIcon().color}>{stateIcon().icon} </text>
        </Show>
        <text fg={merged.theme.text}>
          {padText(fitText(merged.entry.name, nameWidth()), nameWidth())}
        </text>
        <Show when={statsSectionWidth() > 0}>
          <box
            style={{
              width: statsSectionWidth(),
              height: 1,
              flexDirection: "row",
              justifyContent: "flex-end",
              backgroundColor: rowBackground(),
            }}
          >
            <For each={stats()}>
              {(stat, index) => (
                <box style={{ height: 1, flexDirection: "row", backgroundColor: rowBackground() }}>
                  <Show when={index() > 0}>
                    <text fg={merged.selected ? merged.theme.text : merged.theme.muted}> </text>
                  </Show>
                  <text
                    fg={
                      stat.kind === "agent-comment"
                        ? merged.theme.noteBorder
                        : stat.kind === "addition"
                          ? merged.theme.badgeAdded
                          : merged.theme.badgeRemoved
                    }
                  >
                    {stat.text}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
      </box>
    </box>
  );
}

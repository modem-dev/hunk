import { MouseButton, type MouseEvent as TuiMouseEvent } from "@opentui/core";
import { memo } from "react";
import type { ExtensionSidebarTheme } from "../../../extension-api/types";
import { fileRowId } from "../../lib/ids";
import {
  sidebarEntryStats,
  type FileDirectoryEntry,
  type FileGroupEntry,
  type FileListEntry,
} from "../../lib/files";
import { fitText, padText } from "../../lib/text";

/**
 * Rows render from the public sidebar theme tokens rather than the full
 * internal theme: the built-in sidebar is a bundled extension consuming the
 * published props, and these rows are what it draws. `AppTheme` satisfies the
 * token slice structurally, so internal callers pass their theme unchanged.
 */

/** Get icon and color for file state using standard git status codes. */
function getFileStateIcon(
  entry: FileListEntry,
  theme: ExtensionSidebarTheme,
): { icon: string; color: string } {
  if (entry.stageStatus)
    return {
      icon: entry.stageStatus,
      color: ["??", "!!"].includes(entry.stageStatus) ? theme.badgeRemoved : theme.badgeAdded,
    };
  if (entry.isUntracked) {
    return { icon: "??", color: theme.badgeRemoved };
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

/** Render one compact folder header, leaving the shared stats column empty. */
export function FileGroupHeader({
  entry,
  paddingLeft = 1,
  selected = false,
  statsWidth = 0,
  textWidth,
  theme,
  onSelect,
}: {
  entry: FileGroupEntry;
  paddingLeft?: number;
  selected?: boolean;
  statsWidth?: number;
  textWidth: number;
  theme: ExtensionSidebarTheme;
  onSelect?: (entryId: string) => void;
}) {
  const rowBackground = selected ? theme.accentMuted : theme.panel;
  const statsSectionWidth = statsWidth > 0 ? statsWidth + 1 : 0;
  const labelWidth = Math.max(1, textWidth - statsSectionWidth);
  return (
    <box
      id={fileRowId(entry.id)}
      style={{
        width: "100%",
        height: 1,
        paddingLeft,
        backgroundColor: rowBackground,
      }}
      onMouseUp={(event) => {
        if (event.button !== MouseButton.LEFT || !onSelect) return;
        onSelect(entry.id);
      }}
    >
      <text fg={selected ? theme.text : theme.muted}>{fitText(entry.label, labelWidth, "…")}</text>
    </box>
  );
}

/** Clamp hierarchy indentation so a row always retains space for its visible label. */
export function fileSidebarIndentWidth(depth: number, textWidth: number, reservedWidth: number) {
  return Math.min(Math.max(0, depth) * 2, Math.max(0, textWidth - reservedWidth - 1));
}

/** Render one mouse-toggleable directory row in the navigation sidebar. */
export function FileDirectoryRow({
  collapsed,
  entry,
  onToggleDirectory,
  paddingLeft = 1,
  selected = false,
  statsWidth = 0,
  textWidth,
  theme,
  onSelect,
}: {
  collapsed: boolean;
  entry: FileDirectoryEntry;
  onToggleDirectory: (path: string) => void;
  paddingLeft?: number;
  selected?: boolean;
  statsWidth?: number;
  textWidth: number;
  theme: ExtensionSidebarTheme;
  onSelect?: (entryId: string) => void;
}) {
  const rowBackground = selected ? theme.accentMuted : theme.panel;
  const statsSectionWidth = statsWidth > 0 ? statsWidth + 1 : 0;
  const countText = collapsed
    ? `${entry.descendantFileCount} ${entry.descendantFileCount === 1 ? "file" : "files"}`
    : null;
  const trailingWidth = countText ? Math.max(statsSectionWidth, countText.length + 1) : 0;
  const disclosureWidth = 2;
  const indentWidth = fileSidebarIndentWidth(
    entry.depth,
    textWidth,
    disclosureWidth + trailingWidth + 1,
  );
  const labelWidth = Math.max(1, textWidth - 1 - disclosureWidth - trailingWidth - indentWidth);

  return (
    <box
      id={fileRowId(entry.id)}
      style={{
        width: "100%",
        height: 1,
        flexDirection: "row",
        backgroundColor: rowBackground,
      }}
      onMouseUp={(event: TuiMouseEvent) => {
        if (event.button === MouseButton.LEFT) {
          onSelect?.(entry.id);
          onToggleDirectory(entry.path);
        }
      }}
    >
      <box style={{ width: 1, height: 1, backgroundColor: rowBackground }} />
      <box
        style={{
          flexGrow: 1,
          height: 1,
          paddingLeft: paddingLeft + indentWidth,
          flexDirection: "row",
          backgroundColor: rowBackground,
        }}
      >
        <text fg={theme.muted}>{collapsed ? "› " : "⌄ "}</text>
        <text fg={selected ? theme.text : theme.muted}>{padText(fitText(entry.label, labelWidth), labelWidth)}</text>
        {countText && (
          <box
            style={{
              width: trailingWidth,
              height: 1,
              flexDirection: "row",
              justifyContent: "flex-end",
              backgroundColor: theme.panel,
            }}
          >
            <text fg={theme.muted}>{countText}</text>
          </box>
        )}
      </box>
    </box>
  );
}

/** Render one file row in the navigation sidebar. */
export const FileListItem = memo(function FileListItem({
  entry,
  paddingLeft = 1,
  selected,
  statsWidth,
  textWidth,
  theme,
  onSelectFile,
}: {
  entry: FileListEntry;
  paddingLeft?: number;
  selected: boolean;
  statsWidth: number;
  textWidth: number;
  theme: ExtensionSidebarTheme;
  onSelectFile: (fileId: string) => void;
}) {
  const rowBackground = selected ? theme.accentMuted : theme.panel;
  const stats = sidebarEntryStats(entry);
  const { icon, color } = getFileStateIcon(entry, theme);
  const fullyStaged = entry.stageStatus?.[0] !== " " && entry.stageStatus?.[1] === " ";
  const nameColor = fullyStaged ? theme.badgeAdded : theme.text;
  const iconWidth = icon ? icon.length + 1 : 0;
  const statsSectionWidth = statsWidth > 0 ? statsWidth + 1 : 0;
  const indentWidth = fileSidebarIndentWidth(
    entry.depth,
    textWidth,
    iconWidth + statsSectionWidth + 1,
  );
  const nameWidth = Math.max(1, textWidth - 1 - iconWidth - statsSectionWidth - indentWidth);

  return (
    <box
      id={fileRowId(entry.id)}
      style={{
        width: "100%",
        height: 1,
        backgroundColor: rowBackground,
        flexDirection: "row",
      }}
      onMouseUp={(event) => {
        if (event.button !== MouseButton.LEFT) return;
        onSelectFile(entry.id);
      }}
    >
      <box
        style={{
          width: 1,
          height: 1,
          backgroundColor: rowBackground,
        }}
      />
      <box
        style={{
          flexGrow: 1,
          height: 1,
          paddingLeft: paddingLeft + indentWidth,
          flexDirection: "row",
          backgroundColor: rowBackground,
        }}
      >
        {icon && (
          <text fg={color}>
            {entry.stageStatus ? (
              <>
                {icon[0]}
                <span fg={theme.badgeRemoved}>{icon[1]}</span>
              </>
            ) : (
              icon
            )}{" "}
          </text>
        )}
        <text fg={nameColor}>{padText(fitText(entry.name, nameWidth, "…"), nameWidth)}</text>
        {statsSectionWidth > 0 && (
          <box
            style={{
              width: statsSectionWidth,
              minWidth: statsSectionWidth,
              flexShrink: 0,
              height: 1,
              flexDirection: "row",
              justifyContent: "flex-end",
              backgroundColor: rowBackground,
            }}
          >
            {stats.map((stat, index) => (
              <box
                key={`${entry.id}:${stat.kind}`}
                style={{ height: 1, flexDirection: "row", backgroundColor: rowBackground }}
              >
                {index > 0 && <text fg={selected ? theme.text : theme.muted}> </text>}
                <text
                  fg={
                    stat.kind === "agent-comment"
                      ? selected
                        ? theme.fileModified
                        : theme.noteBorder
                      : stat.kind === "addition"
                        ? theme.badgeAdded
                        : theme.badgeRemoved
                  }
                >
                  {stat.text}
                </text>
              </box>
            ))}
          </box>
        )}
      </box>
    </box>
  );
});

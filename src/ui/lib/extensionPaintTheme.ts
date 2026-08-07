import type { ExtensionPaintTheme } from "../../extension-api/types";
import type { AppTheme } from "../themes";

/** Project Hunk's active theme onto the one public paint-only extension palette. */
export function toExtensionPaintTheme(theme: AppTheme): ExtensionPaintTheme {
  return Object.freeze({
    appearance: theme.appearance,
    background: theme.background,
    panel: theme.panel,
    panelAlt: theme.panelAlt,
    border: theme.border,
    accent: theme.accent,
    accentMuted: theme.accentMuted,
    text: theme.text,
    muted: theme.muted,
    selectedHunk: theme.selectedHunk,
    badgeAdded: theme.badgeAdded,
    badgeRemoved: theme.badgeRemoved,
    badgeNeutral: theme.badgeNeutral,
    fileNew: theme.fileNew,
    fileDeleted: theme.fileDeleted,
    fileRenamed: theme.fileRenamed,
    fileModified: theme.fileModified,
    fileUntracked: theme.fileUntracked,
    noteBorder: theme.noteBorder,
  });
}

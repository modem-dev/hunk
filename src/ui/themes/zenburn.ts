import { withLazySyntaxStyle } from "./syntax";
import type { AppTheme } from "./types";

/**
 * Zenburn — a warm, low-contrast dark theme by @ramin, inspired by and slightly
 * modified from the original Zenburn by Jani Nurminen. Warm off-white text,
 * cyan-blue functions and types, sage comments, and dusty-red strings.
 */
export const ZENBURN_THEME: AppTheme = withLazySyntaxStyle(
  {
    id: "zenburn",
    label: "Zenburn",
    appearance: "dark",
    background: "#3f3f3f",
    panel: "#3a3a3a",
    panelAlt: "#313633",
    border: "#4d4d4d",
    accent: "#93e0e3",
    accentMuted: "#709080",
    text: "#dcdccc",
    muted: "#709080",
    addedBg: "#2e3d30",
    removedBg: "#43302f",
    contextBg: "#393939",
    addedContentBg: "#3a4d3c",
    removedContentBg: "#553a39",
    contextContentBg: "#3f3f3f",
    addedSignColor: "#60b48a",
    removedSignColor: "#dca3a3",
    lineNumberBg: "#3a3a3a",
    lineNumberFg: "#709080",
    selectedHunk: "#4a554d",
    badgeAdded: "#60b48a",
    badgeRemoved: "#dca3a3",
    badgeNeutral: "#c3bf9f",
    fileNew: "#60b48a",
    fileDeleted: "#dca3a3",
    fileRenamed: "#e0cf9f",
    fileModified: "#e0cf9f",
    fileUntracked: "#8cd0d3",
    noteBorder: "#dc8cc3",
    noteBackground: "#3a3340",
    noteTitleBackground: "#46394e",
    noteTitleText: "#f0e6f5",
  },
  {
    default: "#dcdccc",
    keyword: "#f0dfaf",
    string: "#dca3a3",
    comment: "#60b48a",
    number: "#8cd0d3",
    function: "#94bff3",
    property: "#c3bf9f",
    type: "#94bff3",
    punctuation: "#dcdccc",
  },
);

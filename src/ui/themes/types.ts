import type { SyntaxStyle } from "@opentui/core";

export interface AppTheme {
  id: string;
  label: string;
  appearance: "light" | "dark";
  background: string;
  panel: string;
  panelAlt: string;
  border: string;
  accent: string;
  accentMuted: string;
  text: string;
  muted: string;
  addedBg: string;
  removedBg: string;
  movedAddedBg: string;
  movedRemovedBg: string;
  contextBg: string;
  addedContentBg: string;
  removedContentBg: string;
  contextContentBg: string;
  addedSignColor: string;
  removedSignColor: string;
  lineNumberBg: string;
  lineNumberFg: string;
  selectedHunk: string;
  badgeAdded: string;
  badgeRemoved: string;
  badgeNeutral: string;
  fileNew: string;
  fileDeleted: string;
  fileRenamed: string;
  fileModified: string;
  fileUntracked: string;
  noteBorder: string;
  noteBackground: string;
  noteTitleBackground: string;
  noteTitleText: string;
  syntaxColors: SyntaxColors;
  syntaxStyle: SyntaxStyle;
}

export type SyntaxColors = {
  default: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  function: string;
  property: string;
  type: string;
  punctuation: string;
};

export type ThemeBase = Omit<AppTheme, "syntaxColors" | "syntaxStyle">;

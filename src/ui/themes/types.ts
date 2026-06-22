import type { SyntaxStyle } from "@opentui/core";

/** Whether chrome boundaries are drawn as lines/boxes or as filled background bands. */
export type ChromeMode = "bordered" | "borderless";

/**
 * Ordered elevation ladder of background surfaces, low -> high. Adjacent levels
 * are derived to stay visually distinct so borderless chrome reads as layered
 * bands instead of one flat field. Every theme carries the full ladder; the
 * active {@link ChromeMode} decides whether primitives draw a border or fill a band.
 */
export interface ChromeSurfaces {
  /** Editor body / code area (base). */
  code: string;
  /** Quiet context affordances inside a file, e.g. the unchanged-lines/gap toggle. */
  contextBand: string;
  /** File-section headers and the top menu bar. */
  sectionHeader: string;
  /** File-tree sidebar panel. */
  sidebar: string;
  /** Floating overlays: popups, menus, dialogs. */
  overlay: string;
  /** Agent comment body. */
  note: string;
  /** Agent comment title band. */
  noteTitle: string;
  /** Hovered/selected row inside menus and lists. */
  selection: string;
  /** Primary/active selection (accent), e.g. the active theme row or a Save action. */
  selectionPrimary: string;
}

export interface AppTheme {
  id: string;
  label: string;
  appearance: "light" | "dark";
  /** How chrome boundaries render. Defaults to "bordered"; set per the user toggle. */
  chrome: ChromeMode;
  /** Derived elevation ladder used by borderless chrome primitives. */
  surfaces: ChromeSurfaces;
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
  /** Optional Shiki/Pierre theme name for source-accurate code highlighting. */
  syntaxTheme?: string;
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
  variable?: string;
  operator?: string;
  punctuation: string;
};

export type ThemeBase = Omit<AppTheme, "syntaxColors" | "syntaxStyle" | "chrome" | "surfaces">;

import type { ThemeMode } from "@opentui/core";
import type { CustomThemeConfig } from "../core/types";
import {
  CATPPUCCIN_FRAPPE_THEME,
  CATPPUCCIN_LATTE_THEME,
  CATPPUCCIN_MACCHIATO_THEME,
  CATPPUCCIN_MOCHA_THEME,
} from "./themes/catppuccin";
import { EMBER_THEME } from "./themes/ember";
import { GRAPHITE_THEME } from "./themes/graphite";
import { MIDNIGHT_THEME } from "./themes/midnight";
import { PAPER_THEME } from "./themes/paper";
import { withLazySyntaxStyle } from "./themes/syntax";
import type { AppTheme, ThemeBase } from "./themes/types";
import { ZENBURN_THEME } from "./themes/zenburn";

export { CATPPUCCIN_PALETTES } from "./themes/catppuccin";
export type { AppTheme, SyntaxColors, ThemeBase } from "./themes/types";

export const THEMES: AppTheme[] = [
  GRAPHITE_THEME,
  MIDNIGHT_THEME,
  PAPER_THEME,
  EMBER_THEME,
  CATPPUCCIN_LATTE_THEME,
  CATPPUCCIN_FRAPPE_THEME,
  CATPPUCCIN_MACCHIATO_THEME,
  CATPPUCCIN_MOCHA_THEME,
  ZENBURN_THEME,
];

/** Return the built-in theme by id so config-defined themes can inherit from it. */
function builtInThemeById(themeId: string | undefined) {
  return THEMES.find((theme) => theme.id === themeId);
}

/** Return the explicit built-in fallback theme used across startup and missing ids. */
function fallbackTheme() {
  return builtInThemeById("graphite") ?? THEMES[0]!;
}

/** Build one config-defined custom theme by inheriting from a built-in base palette. */
function buildCustomTheme(customTheme: CustomThemeConfig) {
  const baseTheme = builtInThemeById(customTheme.base) ?? fallbackTheme();
  const themeBase: ThemeBase = {
    ...baseTheme,
    id: "custom",
    label: customTheme.label ?? "Custom",
    background: customTheme.background ?? baseTheme.background,
    panel: customTheme.panel ?? baseTheme.panel,
    panelAlt: customTheme.panelAlt ?? baseTheme.panelAlt,
    border: customTheme.border ?? baseTheme.border,
    accent: customTheme.accent ?? baseTheme.accent,
    accentMuted: customTheme.accentMuted ?? baseTheme.accentMuted,
    text: customTheme.text ?? baseTheme.text,
    muted: customTheme.muted ?? baseTheme.muted,
    addedBg: customTheme.addedBg ?? baseTheme.addedBg,
    removedBg: customTheme.removedBg ?? baseTheme.removedBg,
    contextBg: customTheme.contextBg ?? baseTheme.contextBg,
    addedContentBg: customTheme.addedContentBg ?? baseTheme.addedContentBg,
    removedContentBg: customTheme.removedContentBg ?? baseTheme.removedContentBg,
    contextContentBg: customTheme.contextContentBg ?? baseTheme.contextContentBg,
    addedSignColor: customTheme.addedSignColor ?? baseTheme.addedSignColor,
    removedSignColor: customTheme.removedSignColor ?? baseTheme.removedSignColor,
    lineNumberBg: customTheme.lineNumberBg ?? baseTheme.lineNumberBg,
    lineNumberFg: customTheme.lineNumberFg ?? baseTheme.lineNumberFg,
    selectedHunk: customTheme.selectedHunk ?? baseTheme.selectedHunk,
    badgeAdded: customTheme.badgeAdded ?? baseTheme.badgeAdded,
    badgeRemoved: customTheme.badgeRemoved ?? baseTheme.badgeRemoved,
    badgeNeutral: customTheme.badgeNeutral ?? baseTheme.badgeNeutral,
    fileNew: customTheme.fileNew ?? baseTheme.fileNew,
    fileDeleted: customTheme.fileDeleted ?? baseTheme.fileDeleted,
    fileRenamed: customTheme.fileRenamed ?? baseTheme.fileRenamed,
    fileModified: customTheme.fileModified ?? baseTheme.fileModified,
    fileUntracked: customTheme.fileUntracked ?? baseTheme.fileUntracked,
    noteBorder: customTheme.noteBorder ?? baseTheme.noteBorder,
    noteBackground: customTheme.noteBackground ?? baseTheme.noteBackground,
    noteTitleBackground: customTheme.noteTitleBackground ?? baseTheme.noteTitleBackground,
    noteTitleText: customTheme.noteTitleText ?? baseTheme.noteTitleText,
  };

  return withLazySyntaxStyle(themeBase, {
    ...baseTheme.syntaxColors,
    ...customTheme.syntax,
  });
}

/** Return the theme ids the app should expose based on whether config defines a custom palette. */
export function availableThemeIds(customTheme?: CustomThemeConfig): string[] {
  const themeIds = THEMES.map((theme) => theme.id);
  if (customTheme) {
    themeIds.push("custom");
  }
  return themeIds;
}

/** Return the menu/cycle themes, adding the config-defined custom theme only when available. */
export function availableThemes(customTheme?: CustomThemeConfig): AppTheme[] {
  return customTheme ? [...THEMES, buildCustomTheme(customTheme)] : THEMES;
}

/** Resolve a named theme, including explicit terminal-background auto mode and custom themes, or fall back to Hunk's explicit built-in default. */
export function resolveTheme(
  requested: string | undefined,
  themeMode: ThemeMode | null,
  customTheme?: CustomThemeConfig,
) {
  if (requested === "auto") {
    const preferred = themeMode === "light" ? "paper" : "graphite";
    return THEMES.find((theme) => theme.id === preferred) ?? THEMES[0]!;
  } else if (requested === "custom" && customTheme) {
    return buildCustomTheme(customTheme);
  }

  const exact = THEMES.find((theme) => theme.id === requested);
  if (exact) {
    return exact;
  }

  return fallbackTheme();
}

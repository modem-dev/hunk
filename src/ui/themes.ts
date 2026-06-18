import type { ThemeMode } from "@opentui/core";
import type { CustomThemeConfig } from "../core/types";
import { blendHex, contrastRatio, relativeLuminance } from "./lib/color";
import { getBundledShikiThemeBackground, getBundledShikiThemeForeground } from "./lib/shikiThemes";
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

export const TRANSPARENT_BACKGROUND = "transparent";

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
    movedAddedBg: customTheme.movedAddedBg ?? baseTheme.movedAddedBg,
    movedRemovedBg: customTheme.movedRemovedBg ?? baseTheme.movedRemovedBg,
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
    // Explicit syntax color overrides should use Hunk's semantic remap path rather than the
    // inherited Shiki theme, otherwise the overrides would never affect highlighted code.
    syntaxTheme: customTheme.syntax ? undefined : baseTheme.syntaxTheme,
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

export type SyntaxBackgroundMode = "tokens-only" | "editor-surface" | "pierre-surface";

// Flip these while evaluating syntax-theme backgrounds. Pierre mode keeps Shiki token colors but
// uses Pierre's stable editor surface instead of each Shiki theme's own background.
export const USE_SHIKI_EDITOR_BACKGROUNDS = false;
export const USE_PIERRE_EDITOR_BACKGROUNDS = true;

const DEFAULT_SYNTAX_BACKGROUND_MODE: SyntaxBackgroundMode = USE_SHIKI_EDITOR_BACKGROUNDS
  ? "editor-surface"
  : USE_PIERRE_EDITOR_BACKGROUNDS
    ? "pierre-surface"
    : "tokens-only";

const PIERRE_EDITOR_SURFACES = {
  dark: { background: "#0a0a0a", foreground: "#fafafa" },
  light: { background: "#ffffff", foreground: "#0a0a0a" },
} as const;
const MIN_GUTTER_CONTRAST = 4.5;
const MIN_DIFF_SIGN_CONTRAST = 3;

/** Return a high-contrast foreground layered over an arbitrary editor surface. */
function readableForeground(preferred: string | undefined, background: string) {
  if (preferred && contrastRatio(preferred, background) >= MIN_GUTTER_CONTRAST) {
    return preferred;
  }

  return relativeLuminance(background) > 0.45 ? "#000000" : "#ffffff";
}

/** Return a readable dim foreground for gutters layered over an arbitrary editor surface. */
function readableDimForeground(preferred: string, background: string) {
  if (contrastRatio(preferred, background) >= MIN_GUTTER_CONTRAST) {
    return preferred;
  }

  return relativeLuminance(background) > 0.45
    ? blendHex("#000000", background, 0.62)
    : blendHex("#ffffff", background, 0.62);
}

/** Return a semantic diff marker color that remains legible on a syntax editor surface. */
function readableDiffSign(preferred: string, background: string) {
  if (contrastRatio(preferred, background) >= MIN_DIFF_SIGN_CONTRAST) {
    return preferred;
  }

  return relativeLuminance(background) > 0.45
    ? blendHex("#000000", preferred, 0.45)
    : blendHex("#ffffff", preferred, 0.45);
}

/** Derive diff row tints around one syntax theme editor background. */
function withSyntaxEditorSurface(
  theme: AppTheme,
  editorBackground: string,
  editorForeground: string | undefined,
): AppTheme {
  const isLightSurface = relativeLuminance(editorBackground) > 0.45;
  const rowTint = isLightSurface ? 0.09 : 0.14;
  const contentTint = isLightSurface ? 0.16 : 0.23;
  const movedTint = isLightSurface ? 0.13 : 0.19;
  const selectedTint = isLightSurface ? 0.14 : 0.2;
  const neutralPanel = blendHex(theme.panel, editorBackground, isLightSurface ? 0.1 : 0.18);
  const addedSignColor = readableDiffSign(theme.addedSignColor, editorBackground);
  const removedSignColor = readableDiffSign(theme.removedSignColor, editorBackground);
  const codeForeground = readableForeground(editorForeground, editorBackground);

  return {
    ...theme,
    background: editorBackground,
    contextBg: editorBackground,
    contextContentBg: editorBackground,
    addedBg: blendHex(addedSignColor, editorBackground, rowTint),
    removedBg: blendHex(removedSignColor, editorBackground, rowTint),
    movedAddedBg: blendHex(addedSignColor, editorBackground, movedTint),
    movedRemovedBg: blendHex(removedSignColor, editorBackground, movedTint),
    addedContentBg: blendHex(addedSignColor, editorBackground, contentTint),
    removedContentBg: blendHex(removedSignColor, editorBackground, contentTint),
    addedSignColor,
    removedSignColor,
    lineNumberBg: editorBackground,
    lineNumberFg: readableDimForeground(theme.lineNumberFg, editorBackground),
    selectedHunk: blendHex(theme.accent, editorBackground, selectedTint),
    noteBackground: neutralPanel,
    noteTitleBackground: neutralPanel,
    syntaxColors: {
      ...theme.syntaxColors,
      default: codeForeground,
      variable: theme.syntaxColors.variable ?? codeForeground,
    },
  };
}

/** Return a copy of a theme with a configured Shiki syntax theme and background policy. */
export function withSyntaxTheme(
  theme: AppTheme,
  syntaxTheme: string | undefined,
  syntaxBackgroundMode = DEFAULT_SYNTAX_BACKGROUND_MODE,
): AppTheme {
  if (!syntaxTheme) {
    return theme;
  }

  const nextTheme = { ...theme, syntaxTheme };
  if (syntaxBackgroundMode === "tokens-only") {
    return nextTheme;
  }

  if (syntaxBackgroundMode === "pierre-surface") {
    const surface = PIERRE_EDITOR_SURFACES[theme.appearance];
    return withSyntaxEditorSurface(nextTheme, surface.background, surface.foreground);
  }

  const editorBackground = getBundledShikiThemeBackground(syntaxTheme);
  const editorForeground = getBundledShikiThemeForeground(syntaxTheme);
  return editorBackground
    ? withSyntaxEditorSurface(nextTheme, editorBackground, editorForeground)
    : nextTheme;
}

/** Return a copy of a theme whose painted surfaces allow the terminal background through. */
export function withTransparentBackground(theme: AppTheme): AppTheme {
  return {
    ...theme,
    background: TRANSPARENT_BACKGROUND,
    panel: TRANSPARENT_BACKGROUND,
    panelAlt: TRANSPARENT_BACKGROUND,
    addedBg: TRANSPARENT_BACKGROUND,
    removedBg: TRANSPARENT_BACKGROUND,
    contextBg: TRANSPARENT_BACKGROUND,
    addedContentBg: TRANSPARENT_BACKGROUND,
    removedContentBg: TRANSPARENT_BACKGROUND,
    contextContentBg: TRANSPARENT_BACKGROUND,
    lineNumberBg: TRANSPARENT_BACKGROUND,
    selectedHunk: TRANSPARENT_BACKGROUND,
    noteBackground: TRANSPARENT_BACKGROUND,
    noteTitleBackground: TRANSPARENT_BACKGROUND,
  };
}

/**
 * Return a copy of a theme whose neutral surfaces allow the terminal background through while
 * added/removed row tints stay painted. Static pager hosts use this so diff rows keep their
 * semantic backgrounds on translucent terminals.
 */
export function withTransparentSurfaces(theme: AppTheme): AppTheme {
  return {
    ...theme,
    background: TRANSPARENT_BACKGROUND,
    panel: TRANSPARENT_BACKGROUND,
    panelAlt: TRANSPARENT_BACKGROUND,
    contextBg: TRANSPARENT_BACKGROUND,
    contextContentBg: TRANSPARENT_BACKGROUND,
    lineNumberBg: TRANSPARENT_BACKGROUND,
  };
}

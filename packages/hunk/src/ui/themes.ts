import type { ThemeMode } from "@opentui/core";
import { LEGACY_CUSTOM_THEME_ID } from "../core/theme/customThemes";
import { resolveSyntaxScopeOverrides } from "../core/theme/legacySyntaxScopes";
import type { NamedCustomThemeConfig } from "../extension-api/types";
import { blendHex, contrastRatio, hexColorDistance, relativeLuminance } from "./lib/color";
import {
  BUNDLED_SHIKI_THEME_IDS,
  resolveBundledShikiThemeId,
  getBundledShikiThemeBackground,
  getBundledShikiThemeDiffColors,
  getBundledShikiThemeForeground,
  type BundledShikiThemeDiffColors,
  type BundledShikiThemeId,
} from "../core/theme/catalog";
import { themeModeForTerminalColors } from "../core/theme/detection";
import {
  ANSI_COLOR_INDEX,
  FALLBACK_TERMINAL_COLORS,
  getDetectedTerminalColors,
  TERMINAL_THEME_ID,
  type TerminalColors,
} from "../core/theme/terminalColors";
import type { AppTheme, SyntaxColors, ThemeBase } from "./themes/types";

export type { AppTheme } from "./themes/types";

export const TRANSPARENT_BACKGROUND = "transparent";
export const DEFAULT_DARK_THEME_ID = "github-dark-default";
export const DEFAULT_LIGHT_THEME_ID = "github-light-default";

const MIN_GUTTER_CONTRAST = 4.5;
export const MIN_DIFF_SIGN_CONTRAST = 3;
export const MIN_EMPHASIS_SEPARATION = 28;

const FALLBACK_DIFF_COLORS = {
  dark: { added: "#5ecc71", removed: "#ff6762", modified: "#69b1ff" },
  light: { added: "#0dbe4e", removed: "#ff2e3f", modified: "#009fff" },
} as const;

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

/** Return a semantic diff marker color that remains legible on a theme editor surface. */
export function readableDiffSign(preferred: string, background: string) {
  if (contrastRatio(preferred, background) >= MIN_DIFF_SIGN_CONTRAST) {
    return preferred;
  }

  let anchor = relativeLuminance(background) > 0.45 ? "#000000" : "#ffffff";
  if (contrastRatio(anchor, background) < MIN_DIFF_SIGN_CONTRAST) {
    anchor = anchor === "#000000" ? "#ffffff" : "#000000";
  }
  for (let amount = 0.02; amount < 1; amount += 0.02) {
    const candidate = blendHex(anchor, preferred, amount);
    if (contrastRatio(candidate, background) >= MIN_DIFF_SIGN_CONTRAST) {
      return candidate;
    }
  }

  return anchor;
}

/** Build Hunk's fallback semantic syntax palette for non-Shiki custom highlighting. */
function buildSyntaxColors(codeForeground: string): SyntaxColors {
  return {
    default: codeForeground,
    keyword: codeForeground,
    string: codeForeground,
    comment: codeForeground,
    number: codeForeground,
    function: codeForeground,
    property: codeForeground,
    type: codeForeground,
    variable: codeForeground,
    operator: codeForeground,
    punctuation: codeForeground,
  };
}

/** Return the strongest tinted background that keeps foreground text readable. */
function readableTintedBackground(
  tintColor: string,
  background: string,
  foreground: string,
  preferredAmount: number,
) {
  // Step by 0.01 so pale accents stop at their full readable strength; a coarser 0.02 step can
  // round the word-emphasis tint down and leave the row tint without enough separation room.
  // Step counts stay integral so accumulated float drift cannot skip the final step.
  const maxSteps = Math.round(preferredAmount / 0.01);
  for (let step = maxSteps; step >= 1; step -= 1) {
    const candidate = blendHex(tintColor, background, step * 0.01);
    if (contrastRatio(foreground, candidate) >= MIN_GUTTER_CONTRAST) {
      return candidate;
    }
  }

  return background;
}

/** Return the strongest readable row tint that stays visibly apart from the word-emphasis tint. */
function readableSeparatedRowBackground(
  tintColor: string,
  background: string,
  foreground: string,
  preferredAmount: number,
  contentBackground: string,
) {
  let readableFallback: string | undefined;
  // Step counts stay integral so accumulated float drift cannot skip the final 0.02 step.
  const maxSteps = Math.round(preferredAmount / 0.02);
  for (let step = maxSteps; step >= 1; step -= 1) {
    const candidate = blendHex(tintColor, background, step * 0.02);
    if (contrastRatio(foreground, candidate) < MIN_GUTTER_CONTRAST) {
      continue;
    }
    if (hexColorDistance(candidate, contentBackground) >= MIN_EMPHASIS_SEPARATION) {
      return candidate;
    }
    readableFallback ??= candidate;
  }

  return readableFallback ?? background;
}

/** Keep semantic status colors readable on sidebar and menu surfaces. */
function readableChromeColor(preferred: string, panel: string, panelAlt: string) {
  if (
    contrastRatio(preferred, panel) >= MIN_GUTTER_CONTRAST &&
    contrastRatio(preferred, panelAlt) >= MIN_GUTTER_CONTRAST
  ) {
    return preferred;
  }

  const lightPanel = relativeLuminance(panelAlt) > 0.45;
  const anchor = lightPanel ? "#000000" : "#ffffff";
  for (const amount of [0.35, 0.5, 0.65, 0.8, 1]) {
    const candidate = blendHex(anchor, preferred, amount);
    if (
      contrastRatio(candidate, panel) >= MIN_GUTTER_CONTRAST &&
      contrastRatio(candidate, panelAlt) >= MIN_GUTTER_CONTRAST
    ) {
      return candidate;
    }
  }

  return anchor;
}

interface DerivedThemeSource {
  id: string;
  label: string;
  editorBackground: string;
  editorForeground?: string;
  diffColors?: BundledShikiThemeDiffColors;
  syntaxTheme?: string;
  syntaxScopeOverrides?: Record<string, string>;
  syntaxScopesReplaceBase?: boolean;
}

/** Derive one complete Hunk theme from an editor surface, foreground, and diff accents. */
function buildDerivedTheme({
  id,
  label,
  editorBackground,
  editorForeground,
  diffColors,
  syntaxTheme,
  syntaxScopeOverrides,
  syntaxScopesReplaceBase,
}: DerivedThemeSource): AppTheme {
  const isLightSurface = relativeLuminance(editorBackground) > 0.45;
  const fallbackDiffColors = FALLBACK_DIFF_COLORS[isLightSurface ? "light" : "dark"];
  const rowTint = isLightSurface ? 0.12 : 0.2;
  const contentTint = isLightSurface ? 0.18 : 0.28;
  const selectedTint = isLightSurface ? 0.18 : 0.25;
  const codeForeground = readableForeground(editorForeground, editorBackground);
  const neutralPanel = blendHex(codeForeground, editorBackground, isLightSurface ? 0.04 : 0.08);
  const neutralPanelAlt = blendHex(codeForeground, editorBackground, isLightSurface ? 0.08 : 0.12);
  const neutralBorder = blendHex(codeForeground, editorBackground, isLightSurface ? 0.15 : 0.18);
  const textForeground = readableForeground(editorForeground ?? codeForeground, neutralPanelAlt);
  const lineNumberForeground = readableDimForeground(
    blendHex(textForeground, editorBackground, 0.56),
    editorBackground,
  );
  const mutedForeground = readableDimForeground(
    blendHex(textForeground, editorBackground, 0.56),
    neutralPanelAlt,
  );
  const addedSignColor = readableDiffSign(
    diffColors?.added ?? fallbackDiffColors.added,
    editorBackground,
  );
  const removedSignColor = readableDiffSign(
    diffColors?.removed ?? fallbackDiffColors.removed,
    editorBackground,
  );
  const modifiedColor = readableDiffSign(
    diffColors?.modified ?? fallbackDiffColors.modified,
    editorBackground,
  );
  const addedContentBg = readableTintedBackground(
    addedSignColor,
    editorBackground,
    textForeground,
    contentTint,
  );
  const removedContentBg = readableTintedBackground(
    removedSignColor,
    editorBackground,
    textForeground,
    contentTint,
  );
  const addedBg = readableSeparatedRowBackground(
    addedSignColor,
    editorBackground,
    textForeground,
    rowTint,
    addedContentBg,
  );
  const removedBg = readableSeparatedRowBackground(
    removedSignColor,
    editorBackground,
    textForeground,
    rowTint,
    removedContentBg,
  );
  const movedBg = readableTintedBackground(
    modifiedColor,
    editorBackground,
    textForeground,
    rowTint,
  );
  const accentMuted = readableTintedBackground(
    modifiedColor,
    editorBackground,
    textForeground,
    selectedTint,
  );
  const syntaxColors = buildSyntaxColors(textForeground);
  const badgeAdded = readableChromeColor(addedSignColor, neutralPanel, neutralPanelAlt);
  const badgeRemoved = readableChromeColor(removedSignColor, neutralPanel, neutralPanelAlt);
  const badgeModified = readableChromeColor(modifiedColor, neutralPanel, neutralPanelAlt);
  const themeBase: ThemeBase = {
    id,
    label,
    appearance: isLightSurface ? "light" : "dark",
    background: editorBackground,
    panel: neutralPanel,
    panelAlt: neutralPanelAlt,
    border: neutralBorder,
    accent: modifiedColor,
    accentMuted,
    text: textForeground,
    muted: mutedForeground,
    contextBg: editorBackground,
    contextContentBg: editorBackground,
    addedBg,
    removedBg,
    movedAddedBg: movedBg,
    movedRemovedBg: movedBg,
    addedContentBg,
    removedContentBg,
    addedSignColor,
    removedSignColor,
    lineNumberBg: editorBackground,
    lineNumberFg: lineNumberForeground,
    copyAction: lineNumberForeground,
    selectedHunk: blendHex(modifiedColor, editorBackground, selectedTint),
    noteBackground: neutralPanel,
    noteBorder: modifiedColor,
    noteTitleBackground: neutralPanel,
    noteTitleText: textForeground,
    badgeAdded,
    badgeRemoved,
    badgeNeutral: mutedForeground,
    fileNew: badgeAdded,
    fileDeleted: badgeRemoved,
    fileRenamed: badgeModified,
    fileModified: badgeModified,
    fileUntracked: badgeAdded,
    syntaxTheme,
    ...(syntaxScopeOverrides ? { syntaxScopeOverrides } : {}),
    ...(syntaxScopesReplaceBase ? { syntaxScopesReplaceBase } : {}),
  };

  return { ...themeBase, syntaxColors };
}

/** Derive one complete Hunk theme from one bundled Shiki editor theme. */
function buildShikiTheme(themeId: BundledShikiThemeId): AppTheme {
  return buildDerivedTheme({
    id: themeId,
    label: themeId,
    editorBackground: getBundledShikiThemeBackground(themeId) ?? "#0d1117",
    editorForeground: getBundledShikiThemeForeground(themeId),
    diffColors: getBundledShikiThemeDiffColors(themeId),
    syntaxTheme: themeId,
  });
}

/** Return one ANSI palette slot, falling back to the stand-in palette the terminal resembles. */
function terminalPaletteColor(
  colors: TerminalColors | undefined,
  fallback: (typeof FALLBACK_TERMINAL_COLORS)[keyof typeof FALLBACK_TERMINAL_COLORS],
  slot: keyof typeof ANSI_COLOR_INDEX,
) {
  const index = ANSI_COLOR_INDEX[slot];
  return colors?.palette[index] ?? fallback.palette[index];
}

/**
 * Map TextMate scopes onto ANSI palette slots the way terminal editors and pagers
 * conventionally color code, so highlighting matches the rest of the user's terminal.
 */
const TERMINAL_SYNTAX_SCOPES: [readonly string[], keyof typeof ANSI_COLOR_INDEX][] = [
  [["comment", "punctuation.definition.comment", "string.comment"], "brightBlack"],
  [["keyword", "storage", "keyword.control", "storage.type", "storage.modifier"], "magenta"],
  [["keyword.operator.new", "keyword.operator.expression", "keyword.operator.logical"], "magenta"],
  [["string", "punctuation.definition.string", "string.template", "markup.inline.raw"], "green"],
  [["string.regexp", "constant.character.escape"], "cyan"],
  [["constant.numeric", "constant.language", "constant.character", "support.constant"], "cyan"],
  [
    [
      "entity.name.function",
      "support.function",
      "variable.function",
      "meta.function-call entity.name.function",
      "markup.heading",
    ],
    "blue",
  ],
  [
    [
      "entity.name.type",
      "entity.name.class",
      "entity.name.namespace",
      "entity.other.inherited-class",
      "support.type",
      "support.class",
      "entity.other.attribute-name",
    ],
    "yellow",
  ],
  [["entity.name.tag", "variable.language", "markup.deleted", "invalid"], "red"],
  [["markup.inserted"], "green"],
];

const terminalThemeCache = new Map<
  "light" | "dark",
  { colors: TerminalColors | undefined; theme: AppTheme }
>();

/**
 * Derive the `terminal` theme from the terminal's own default colors and ANSI palette, so Hunk
 * looks like part of the user's terminal instead of a separate editor color scheme.
 */
function buildTerminalTheme(themeMode?: ThemeMode | null): AppTheme {
  const colors = getDetectedTerminalColors();
  const mode = themeModeForTerminalColors(colors) ?? (themeMode === "light" ? "light" : "dark");
  // Theme consumers memoize on identity, so hand back the same object for the same inputs.
  const cached = terminalThemeCache.get(mode);
  if (cached && cached.colors === colors) {
    return cached.theme;
  }

  const fallback = FALLBACK_TERMINAL_COLORS[mode];
  const foreground = colors?.foreground ?? fallback.foreground;
  const color = (slot: keyof typeof ANSI_COLOR_INDEX) =>
    terminalPaletteColor(colors, fallback, slot);

  // Rules replace the base syntax theme's own, so every unmatched token falls back to the
  // terminal foreground instead of leaking a bundled editor palette.
  const syntaxScopeOverrides: Record<string, string> = { source: foreground };
  for (const [scopes, slot] of TERMINAL_SYNTAX_SCOPES) {
    for (const scope of scopes) {
      syntaxScopeOverrides[scope] = color(slot);
    }
  }

  const theme = buildDerivedTheme({
    id: TERMINAL_THEME_ID,
    label: TERMINAL_THEME_ID,
    editorBackground: colors?.background ?? fallback.background,
    editorForeground: foreground,
    diffColors: { added: color("green"), removed: color("red"), modified: color("blue") },
    syntaxScopeOverrides,
    syntaxScopesReplaceBase: true,
  });
  terminalThemeCache.set(mode, { colors, theme });
  return theme;
}

export const THEMES: AppTheme[] = BUNDLED_SHIKI_THEME_IDS.map((themeId) =>
  buildShikiTheme(themeId),
);

/** Return the built-in theme by id so config-defined themes can inherit from it. */
function builtInThemeById(themeId: string | undefined) {
  const resolvedThemeId = resolveBundledShikiThemeId(themeId);
  return THEMES.find((theme) => theme.id === resolvedThemeId);
}

/** Return the GitHub light or dark theme that matches the terminal background. */
function autoTheme(themeMode?: ThemeMode | null) {
  const autoId = themeMode === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
  return builtInThemeById(autoId) ?? THEMES[0]!;
}

/** Build one named custom theme by inheriting from a Shiki-backed base palette. */
function buildCustomTheme(customTheme: NamedCustomThemeConfig) {
  const baseTheme = builtInThemeById(customTheme.base) ?? autoTheme();
  const themeBase: ThemeBase = {
    ...baseTheme,
    id: customTheme.id,
    // The original single-slot `[custom_theme]` theme keeps the label it has always shown;
    // named themes fall back to their own id, exactly like the bundled themes do.
    label:
      customTheme.label ?? (customTheme.id === LEGACY_CUSTOM_THEME_ID ? "Custom" : customTheme.id),
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
    copyAction: customTheme.lineNumberFg ?? baseTheme.copyAction,
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
    // Keep the source-accurate base theme and pass exact TextMate selectors through unchanged.
    // The diff highlighter registers that derived palette with Pierre by content hash.
    syntaxTheme: baseTheme.syntaxTheme,
    // TOML config is normalized at parse time; repeat the adapter here for direct API callers.
    syntaxScopeOverrides: resolveSyntaxScopeOverrides(customTheme.syntax, customTheme.syntaxScopes),
  };

  return { ...themeBase, syntaxColors: baseTheme.syntaxColors };
}

/**
 * Return every selectable theme id: bundled themes first, then custom themes in
 * the order the session resolved them.
 */
export function availableThemeIds(customThemes: readonly NamedCustomThemeConfig[] = []): string[] {
  return [
    TERMINAL_THEME_ID,
    ...THEMES.map((theme) => theme.id),
    ...customThemes.map((theme) => theme.id),
  ];
}

/**
 * Return selectable themes in menu and cycle order.
 *
 * The custom themes are expected to be one already-merged list (config themes
 * before extension themes, ids deduped) so this stays a pure projection.
 */
export function availableThemes(
  customThemes: readonly NamedCustomThemeConfig[] = [],
  themeMode?: ThemeMode | null,
): AppTheme[] {
  return [
    buildTerminalTheme(themeMode),
    ...THEMES,
    ...customThemes.map((customTheme) => buildCustomTheme(customTheme)),
  ];
}

/**
 * Resolve a named theme, including terminal-background auto mode and custom themes.
 *
 * Custom themes are matched before bundled ids so a custom theme that reuses a
 * deprecated built-in alias still resolves to what the user actually defined. No id, or
 * an id nothing defines, resolves to the `terminal` theme.
 */
export function resolveTheme(
  requested: string | undefined,
  themeMode: ThemeMode | null,
  customThemes: readonly NamedCustomThemeConfig[] = [],
) {
  if (requested === "auto") {
    return autoTheme(themeMode);
  }

  const customTheme = requested ? customThemes.find((theme) => theme.id === requested) : undefined;
  if (customTheme) {
    return buildCustomTheme(customTheme);
  }

  const exact = builtInThemeById(requested);
  if (exact) {
    return exact;
  }

  return buildTerminalTheme(themeMode);
}

/**
 * Return a copy of a theme whose neutral surfaces allow the terminal background through while
 * added/removed row tints stay painted. Both the interactive TUI and static pager hosts use
 * this so diff rows keep their semantic backgrounds on translucent terminals.
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

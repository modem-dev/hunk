import { createHash } from "node:crypto";
import {
  registerCustomTheme,
  resolveTheme as resolvePierreTheme,
  type ThemeRegistrationResolved,
} from "@pierre/diffs";
import type { AppTheme } from "../themes";

const PIERRE_THEME = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

const registeredSyntaxThemes = new Set<string>();

/** Build a stable id so each distinct scope palette gets its own Shiki cache entry. */
function syntaxThemeFingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Derive a Shiki theme by appending TextMate scope colors unchanged, or, when the theme asks to
 * replace its base, by keeping only those colors and making `source` the default foreground.
 */
async function buildCustomSyntaxTheme(
  name: string,
  baseThemeName: string,
  scopeOverrides: Record<string, string>,
  replaceBase: boolean,
) {
  const baseTheme = await resolvePierreTheme(baseThemeName);
  const scopeSettings = Object.entries(scopeOverrides).map(([scope, foreground]) => ({
    scope,
    settings: { foreground },
  }));

  if (!replaceBase) {
    return {
      ...baseTheme,
      name,
      settings: [...(baseTheme.settings ?? []), ...scopeSettings],
    } satisfies ThemeRegistrationResolved;
  }

  const foreground = scopeOverrides.source ?? baseTheme.fg;
  return {
    ...baseTheme,
    name,
    fg: foreground,
    colors: { ...baseTheme.colors, "editor.foreground": foreground },
    settings: [{ settings: { foreground } }, ...scopeSettings],
  } satisfies ThemeRegistrationResolved;
}

/** Resolve the content-addressed syntax theme name used for one Hunk app theme. */
export function syntaxHighlightThemeName(theme: AppTheme | AppTheme["appearance"]) {
  if (typeof theme === "string") {
    return PIERRE_THEME[theme];
  }

  const baseThemeName = theme.syntaxTheme ?? PIERRE_THEME[theme.appearance];
  // TextMate resolves equally specific rules by declaration order, so order is part of identity.
  const orderedOverrides = Object.entries(theme.syntaxScopeOverrides ?? {}).map(
    ([scope, color]) => [scope, color.toLowerCase()],
  );
  const fingerprintInput = JSON.stringify({
    baseThemeName,
    orderedOverrides,
    ...(theme.syntaxScopesReplaceBase ? { replaceBase: true } : {}),
  });

  return orderedOverrides.length > 0
    ? `hunk-custom-${syntaxThemeFingerprint(fingerprintInput)}`
    : baseThemeName;
}

/** Register a derived scope theme before Pierre asks its shared highlighter to resolve it. */
export function ensureSyntaxHighlightThemeRegistered(theme: AppTheme | AppTheme["appearance"]) {
  const themeName = syntaxHighlightThemeName(theme);
  if (typeof theme === "string" || !theme.syntaxScopeOverrides) {
    return themeName;
  }

  const baseThemeName = theme.syntaxTheme ?? PIERRE_THEME[theme.appearance];
  if (themeName === baseThemeName) {
    return themeName;
  }

  if (!registeredSyntaxThemes.has(themeName)) {
    const capturedOverrides = { ...theme.syntaxScopeOverrides };
    const replaceBase = theme.syntaxScopesReplaceBase === true;
    registerCustomTheme(themeName, () =>
      buildCustomSyntaxTheme(themeName, baseThemeName, capturedOverrides, replaceBase),
    );
    registeredSyntaxThemes.add(themeName);
  }

  return themeName;
}

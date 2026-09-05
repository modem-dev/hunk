// Resolve STML's symbolic color vocabulary against the active AppTheme.
// Layout keeps colors as strings (tokens, names, or hex) so measurement is
// theme-free; this is the single render-time mapping from that vocabulary to
// concrete colors.

import type { AppTheme } from "../../themes";

/** Fixed fallback palette for ANSI-style color names in agent markup. */
const NAMED_COLORS = new Map<string, string>([
  ["black", "#1c1c1c"],
  ["red", "#e05252"],
  ["green", "#4fb469"],
  ["yellow", "#d9a331"],
  ["blue", "#4f8fd9"],
  ["magenta", "#b969d9"],
  ["cyan", "#3fb5b5"],
  ["white", "#e8e8e8"],
  ["gray", "#8a8a8a"],
  ["grey", "#8a8a8a"],
  ["orange", "#e0873d"],
  ["purple", "#9a6fd0"],
  ["pink", "#d9699a"],
]);

type StmlThemeColorKey =
  | "accent"
  | "accentMuted"
  | "addedSignColor"
  | "removedSignColor"
  | "fileModified"
  | "muted"
  | "panelAlt"
  | "text"
  | "panel"
  | "noteBorder"
  | "background";

/** Theme field selected by each semantic STML color token. */
const THEME_COLOR_KEY_BY_TOKEN = new Map<string, StmlThemeColorKey>([
  ["accent", "accent"],
  ["info", "accentMuted"],
  ["success", "addedSignColor"],
  ["danger", "removedSignColor"],
  ["error", "removedSignColor"],
  ["warning", "fileModified"],
  ["muted", "muted"],
  ["subtle", "panelAlt"],
  ["heading", "text"],
  ["text", "text"],
  ["panel", "panel"],
  ["bg", "panel"],
  ["note-border", "noteBorder"],
  ["badge-text", "background"],
]);

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Map one STML color token to a concrete theme color.
 *
 * Semantic tokens follow the sideshow-term vocabulary (`accent`, `success`,
 * `warning`, `danger`, `info`, `muted`, `subtle`, `heading`) plus a few
 * internal tokens layout emits (`note-border`, `badge-text`). Unknown values
 * resolve to null so callers can degrade to the default text color.
 */
export function resolveStmlColor(token: string | undefined, theme: AppTheme): string | null {
  if (!token) {
    return null;
  }

  const value = token.trim().toLowerCase();

  const themeColorKey = THEME_COLOR_KEY_BY_TOKEN.get(value);
  if (themeColorKey !== undefined) {
    // `badge-text` maps to the app background because badge glyphs sit on a bright
    // background and need the highest-contrast text color in both theme modes.
    return theme[themeColorKey];
  }

  if (HEX_COLOR.test(value)) {
    return value;
  }

  return NAMED_COLORS.get(value) ?? null;
}

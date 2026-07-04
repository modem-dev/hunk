// Resolve STML's symbolic color vocabulary against the active AppTheme.
// Layout keeps colors as strings (tokens, names, or hex) so measurement is
// theme-free; this is the single render-time mapping from that vocabulary to
// concrete colors.

import type { AppTheme } from "../../themes";

/** Fixed fallback palette for ANSI-style color names in agent markup. */
const NAMED_COLORS: Record<string, string> = {
  black: "#1c1c1c",
  red: "#e05252",
  green: "#4fb469",
  yellow: "#d9a331",
  blue: "#4f8fd9",
  magenta: "#b969d9",
  cyan: "#3fb5b5",
  white: "#e8e8e8",
  gray: "#8a8a8a",
  grey: "#8a8a8a",
  orange: "#e0873d",
  purple: "#9a6fd0",
  pink: "#d9699a",
};

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

  switch (value) {
    case "accent":
      return theme.accent;
    case "info":
      return theme.accentMuted;
    case "success":
      return theme.addedSignColor;
    case "danger":
    case "error":
      return theme.removedSignColor;
    case "warning":
      return theme.fileModified;
    case "muted":
      return theme.muted;
    case "subtle":
      return theme.panelAlt;
    case "heading":
    case "text":
      return theme.text;
    case "panel":
    case "bg":
      return theme.panel;
    case "note-border":
      return theme.noteBorder;
    case "badge-text":
      // Badge glyphs sit on a bright badge background, so the app background
      // is the highest-contrast text color on both light and dark themes.
      return theme.background;
    default:
      break;
  }

  if (HEX_COLOR.test(value)) {
    return value;
  }

  return NAMED_COLORS[value] ?? null;
}

// Resolve STML's symbolic color vocabulary against the active AppTheme.
// Layout keeps colors as strings (tokens, names, or hex) so measurement is
// theme-free; this is the single render-time mapping from that vocabulary to
// concrete colors.

import { stmlColorTarget } from "../../../core/review/stml";
import type { AppTheme } from "../../themes";

/**
 * Map one STML color token to a concrete theme color.
 *
 * Unknown values resolve to null so callers can degrade to the default text
 * color.
 */
export function resolveStmlColor(token: string | undefined, theme: AppTheme): string | null {
  // What a value names is the shared vocabulary (`core/review/stml.ts`); only the theme
  // lookup is the terminal's.
  const target = stmlColorTarget(token);
  if (!target) {
    return null;
  }
  return target.kind === "theme" ? theme[target.key] : target.color;
}

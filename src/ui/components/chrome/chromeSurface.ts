import type { AppTheme, ChromeSurfaces } from "../../themes";

/** A named level on the theme's elevation ladder. */
export type SurfaceLevel = keyof ChromeSurfaces;

/**
 * Bordered-mode background for each surface level, i.e. the pre-borderless look.
 * Keeping it here is what lets every component ask for a level by name and get
 * the right value for the active {@link AppTheme.chrome} mode without branching.
 */
function borderedSurfaceBg(theme: AppTheme, level: SurfaceLevel): string {
  switch (level) {
    case "code":
      return theme.background;
    case "contextBand":
      return theme.panelAlt;
    case "sectionHeader":
    case "sidebar":
    case "overlay":
      return theme.panel;
    case "note":
      return theme.noteBackground;
    case "noteTitle":
      return theme.noteTitleBackground;
    case "selection":
      return theme.accentMuted;
    case "selectionPrimary":
      return theme.accent;
  }
}

/**
 * Resolve the background for a chrome surface, honoring the active chrome mode:
 * the derived elevation band in borderless mode, the legacy panel color otherwise.
 * Single decision point so border-vs-band logic never scatters across components.
 */
export function chromeSurfaceBg(theme: AppTheme, level: SurfaceLevel): string {
  return theme.chrome === "borderless" ? theme.surfaces[level] : borderedSurfaceBg(theme, level);
}

/**
 * Background for the top/bottom chrome bars (menu bar, status bar) — the VS Code
 * title/status-bar color (`panelAlt`) in both modes, distinct from the panel-colored
 * file-section headers. Borderless mode only drops the rule under it.
 */
export function topChromeBg(theme: AppTheme): string {
  return theme.panelAlt;
}

/** Box style fragment for a floating overlay (popup, menu, or dialog). */
export interface OverlaySurfaceStyle {
  border: boolean;
  borderColor?: string;
  backgroundColor: string;
}

/**
 * Style a floating overlay: a filled elevated band with no border in borderless
 * mode, or the legacy bordered panel otherwise. The bordered border color varies
 * per surface (dialogs use accent, menus use the neutral border), so callers pass
 * the color their bordered look used.
 */
export function overlaySurfaceStyle(
  theme: AppTheme,
  borderedBorderColor: string,
): OverlaySurfaceStyle {
  if (theme.chrome === "borderless") {
    return { border: false, backgroundColor: theme.surfaces.overlay };
  }
  return { border: true, borderColor: borderedBorderColor, backgroundColor: theme.panel };
}

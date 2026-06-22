import { blendHex } from "../lib/color";
import type { ChromeSurfaces, ThemeBase } from "./types";

/**
 * Map a theme's existing semantic palette onto the {@link ChromeSurfaces} ladder,
 * the way a VS Code theme assigns workbench colors: the editor background for
 * code, the panel color for the sidebar and file-section headers (like the active
 * tab), the dimmer panelAlt for the title/status bars, the gap band, and floating
 * widgets, and the note colors for comment boxes. Using the theme's own tokens
 * (rather than synthetic blends) means each theme keeps its intended chrome
 * direction — lighter-than-editor for github-dark, darker for Shades of Purple —
 * and authored custom themes look native. Adjacent-level distinctness is covered
 * by `surfaces.test.ts`.
 *
 * Note surfaces are the exception: a theme's `noteBackground` is usually just the
 * panel color (fine when a drawn border frames the box), but borderless chrome has
 * no border, so a panel-colored note would dissolve into the stream. We lift the
 * note body and — a touch more — its title band toward the foreground so the filled
 * comment card reads as a distinct, layered surface without any border.
 */
export function deriveSurfaces(theme: ThemeBase): ChromeSurfaces {
  return {
    // Three visibly distinct regions: the editor canvas (code), the file-header / gap
    // bands one step off it (panel), and the sidebar recessed furthest (panelAlt). Header
    // must differ from code, contextBand, and overlay, so panel is its only fit; the sidebar
    // then takes panelAlt so the file tree, the headers, and the canvas never share a shade.
    code: theme.background,
    sidebar: theme.panelAlt,
    sectionHeader: theme.panel,
    contextBand: theme.panelAlt,
    overlay: theme.panelAlt,
    note: blendHex(theme.text, theme.noteBackground, 0.08),
    noteTitle: blendHex(theme.text, theme.noteTitleBackground, 0.16),
    selection: theme.accentMuted,
    selectionPrimary: theme.accent,
  };
}

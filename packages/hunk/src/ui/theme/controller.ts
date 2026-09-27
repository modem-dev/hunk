import { themeModeForTerminalColors, type TerminalThemeMode } from "../../core/theme/detection";
import {
  getDetectedTerminalColors,
  setDetectedTerminalColors,
  type TerminalColors,
} from "../../core/theme/terminalColors";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import { resolveTheme } from "../themes";

export interface ThemeSnapshot {
  themeId: string;
  customThemes: readonly NamedCustomThemeConfig[];
  themeMode: TerminalThemeMode | undefined;
  terminalColors: TerminalColors | undefined;
}

/**
 * Own the committed theme, reloadable catalog, and live terminal colors across one Hunk session.
 *
 * Theme selection commits a new id, config reloads replace the custom catalog, and a terminal
 * theme switch replaces the probed colors; each publishes a new snapshot so every mounted
 * surface re-resolves its palette.
 */
export class ThemeController {
  readonly initialThemeId: string;
  private listeners = new Set<() => void>();
  private snapshot: ThemeSnapshot;

  constructor({
    initialTheme,
    initialThemeMode,
    customThemes,
  }: {
    initialTheme?: string;
    initialThemeMode?: TerminalThemeMode | null;
    customThemes?: readonly NamedCustomThemeConfig[];
  }) {
    this.initialThemeId = resolveTheme(initialTheme, initialThemeMode ?? null, customThemes).id;
    this.snapshot = {
      themeId: this.initialThemeId,
      customThemes: customThemes ?? [],
      themeMode: initialThemeMode ?? undefined,
      terminalColors: getDetectedTerminalColors(),
    };
  }

  /** Return the light/dark mode of the terminal background, when known. */
  get themeMode() {
    return this.snapshot.themeMode;
  }

  /** Return the immutable committed-theme snapshot. */
  getSnapshot = () => this.snapshot;

  /** Subscribe one mounted surface to committed theme changes. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Commit one validated theme identity for all current and future surfaces. */
  commitTheme(themeId: string) {
    if (themeId === this.snapshot.themeId) return;
    this.publish({ ...this.snapshot, themeId });
  }

  /** Replace the reloadable custom-theme catalog without changing the committed identity. */
  replaceCustomThemes(customThemes: readonly NamedCustomThemeConfig[]) {
    if (customThemes === this.snapshot.customThemes) return;
    this.publish({ ...this.snapshot, customThemes });
  }

  /** Adopt freshly probed terminal colors after the user's terminal switched themes. */
  updateTerminalColors(terminalColors: TerminalColors) {
    if (terminalColors === this.snapshot.terminalColors) return;
    setDetectedTerminalColors(terminalColors);
    this.publish({
      ...this.snapshot,
      terminalColors,
      themeMode: themeModeForTerminalColors(terminalColors) ?? this.snapshot.themeMode,
    });
  }

  private publish(snapshot: ThemeSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

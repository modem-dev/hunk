import type { TerminalThemeMode } from "../../core/theme/detection";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import { resolveTheme } from "../themes";

export interface ThemeSnapshot {
  themeId: string;
  customThemes: readonly NamedCustomThemeConfig[];
}

/** Own the committed theme and reloadable catalog across one Hunk session. */
export class ThemeController {
  readonly initialThemeId: string;
  readonly themeMode: TerminalThemeMode | undefined;
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
    this.themeMode = initialThemeMode ?? undefined;
    this.snapshot = { themeId: this.initialThemeId, customThemes: customThemes ?? [] };
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
    this.snapshot = { ...this.snapshot, themeId };
    for (const listener of this.listeners) listener();
  }

  /** Replace the reloadable custom-theme catalog without changing the committed identity. */
  replaceCustomThemes(customThemes: readonly NamedCustomThemeConfig[]) {
    if (customThemes === this.snapshot.customThemes) return;
    this.snapshot = { ...this.snapshot, customThemes };
    for (const listener of this.listeners) listener();
  }
}

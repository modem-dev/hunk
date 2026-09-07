import type { TerminalThemeMode } from "../../core/theme/detection";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import { resolveTheme } from "../themes";

export interface ThemeSnapshot {
  themeId: string;
}

/** Retain the committed theme across every surface mounted in one Hunk session. */
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
    this.snapshot = { themeId: this.initialThemeId };
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
    this.snapshot = { themeId };
    for (const listener of this.listeners) listener();
  }
}

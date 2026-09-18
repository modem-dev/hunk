import type { TerminalThemeMode } from "../../core/theme/detection";
import {
  AUTO_THEME_ID,
  chooseThemeSelectionId,
  themeSelectionsEqual,
  type ThemeSelection,
} from "../../core/theme/selection";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import { resolveTheme } from "../themes";

export interface ThemeSnapshot {
  /** The committed preference: one id, `auto`, or a light/dark pair, exactly as chosen. */
  themeSelection: ThemeSelection;
  customThemes: readonly NamedCustomThemeConfig[];
}

/** Own the committed theme selection and reloadable catalog across one Hunk session. */
export class ThemeController {
  readonly initialThemeSelection: ThemeSelection;
  readonly themeMode: TerminalThemeMode | undefined;
  private listeners = new Set<() => void>();
  private snapshot: ThemeSnapshot;

  constructor({
    initialTheme,
    initialThemeMode,
    customThemes,
  }: {
    initialTheme?: ThemeSelection;
    initialThemeMode?: TerminalThemeMode | null;
    customThemes?: readonly NamedCustomThemeConfig[];
  }) {
    this.themeMode = initialThemeMode ?? undefined;
    // Keep what config asked for (`auto` or a pair) committed until the selector picks one
    // id, so quitting without touching themes never rewrites it as the id it resolved to.
    this.initialThemeSelection =
      initialTheme ?? resolveTheme(undefined, initialThemeMode ?? null).id;
    this.snapshot = {
      themeSelection: this.initialThemeSelection,
      customThemes: customThemes ?? [],
    };
  }

  /** Return the immutable committed-theme snapshot. */
  getSnapshot = () => this.snapshot;

  /** Return the one theme id the committed selection names for this terminal. */
  themeId(): string {
    return resolveThemeSelectionId(
      this.snapshot.themeSelection,
      this.themeMode,
      this.snapshot.customThemes,
    );
  }

  /** Subscribe one mounted surface to committed theme changes. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Commit one validated theme identity for all current and future surfaces. */
  commitTheme(themeSelection: ThemeSelection) {
    if (themeSelectionsEqual(themeSelection, this.snapshot.themeSelection)) return;
    this.snapshot = { ...this.snapshot, themeSelection };
    for (const listener of this.listeners) listener();
  }

  /** Replace the reloadable custom-theme catalog without changing the committed identity. */
  replaceCustomThemes(customThemes: readonly NamedCustomThemeConfig[]) {
    if (customThemes === this.snapshot.customThemes) return;
    this.snapshot = { ...this.snapshot, customThemes };
    for (const listener of this.listeners) listener();
  }
}

/**
 * Name the id a selection asks for on this terminal. A concrete id or one side of a pair is
 * reported as requested, even when the catalog cannot currently resolve it; only `auto`
 * collapses to the resolved fallback.
 */
export function resolveThemeSelectionId(
  selection: ThemeSelection | undefined,
  themeMode: TerminalThemeMode | null | undefined,
  customThemes: readonly NamedCustomThemeConfig[] = [],
): string {
  const chosen = chooseThemeSelectionId(selection, themeMode ?? null);
  return chosen === undefined || chosen === AUTO_THEME_ID
    ? resolveTheme(selection, themeMode ?? null, customThemes).id
    : chosen;
}

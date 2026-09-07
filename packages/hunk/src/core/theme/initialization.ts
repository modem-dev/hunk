import type { NamedCustomThemeConfig } from "../../extension-api/types";
import type { TerminalThemeMode } from "./detection";

/** Theme inputs finalized during startup and retained for every surface in one session. */
export interface SessionThemeInitialization {
  initialTheme?: string;
  initialThemeMode?: TerminalThemeMode;
  customThemes: readonly NamedCustomThemeConfig[];
}

/** Package finalized config, terminal detection, and custom themes into one launch record. */
export function createSessionThemeInitialization({
  initialTheme,
  initialThemeMode,
  customThemes = [],
}: {
  initialTheme?: string;
  initialThemeMode?: TerminalThemeMode;
  customThemes?: readonly NamedCustomThemeConfig[];
}): SessionThemeInitialization {
  return {
    ...(initialTheme === undefined ? {} : { initialTheme }),
    ...(initialThemeMode === undefined ? {} : { initialThemeMode }),
    customThemes,
  };
}

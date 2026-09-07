import type { TerminalThemeMode } from "../theme/detection";
import type { NamedCustomThemeConfig } from "../../extension-api/types";

/** Theme inputs finalized during startup and retained for every surface in one session. */
export interface SessionThemeInitialization {
  initialTheme?: string;
  initialThemeMode?: TerminalThemeMode;
  customThemes: readonly NamedCustomThemeConfig[];
}

/**
 * Carries launch inputs shared by every interactive surface in one Hunk session.
 * Add a concern here only when the session host owns its lifetime across routed surfaces.
 */
export interface InteractiveSessionInitialization {
  theme: SessionThemeInitialization;
}

/** Package finalized cross-surface inputs into one interactive-session launch record. */
export function createInteractiveSessionInitialization({
  theme,
}: {
  theme: Omit<SessionThemeInitialization, "customThemes"> & {
    customThemes?: readonly NamedCustomThemeConfig[];
  };
}): InteractiveSessionInitialization {
  return {
    theme: {
      ...(theme.initialTheme === undefined ? {} : { initialTheme: theme.initialTheme }),
      ...(theme.initialThemeMode === undefined ? {} : { initialThemeMode: theme.initialThemeMode }),
      customThemes: theme.customThemes ?? [],
    },
  };
}

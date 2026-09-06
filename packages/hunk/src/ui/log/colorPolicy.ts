import type { ThemeMode } from "@opentui/core";
import type { HistoryColorMode } from "../../core/run/commandInputs";
import type { AppTheme } from "../themes";
import { resolveHistoryColor } from "../history/staticProjection";

/** Resolve whether interactive history may apply the selected Hunk palette. */
export function interactiveLogUsesColor(
  mode: HistoryColorMode,
  env: NodeJS.ProcessEnv,
  stdoutIsTTY = true,
) {
  return resolveHistoryColor({ mode, env, stdoutIsTTY });
}

/** Replace theme-specific chrome colors with a stable monochrome terminal palette. */
export function monochromeLogTheme(theme: AppTheme, terminalMode: ThemeMode): AppTheme {
  const light = terminalMode === "light";
  const background = light ? "#ffffff" : "#000000";
  const foreground = light ? "#000000" : "#ffffff";
  const selection = light ? "#d0d0d0" : "#404040";
  return {
    ...theme,
    id: "terminal-monochrome",
    label: "Terminal monochrome",
    appearance: light ? "light" : "dark",
    background,
    panel: background,
    panelAlt: background,
    border: foreground,
    accent: foreground,
    accentMuted: selection,
    text: foreground,
    muted: foreground,
    selectedHunk: selection,
    badgeNeutral: foreground,
  };
}

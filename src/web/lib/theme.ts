import { useSyncExternalStore, type CSSProperties } from "react";

export interface HunkWebTheme {
  name: string;
  type: "dark" | "light";
  colors: Record<string, string>;
  diffs: "pierre-dark" | "pierre-light";
}

const DARK_COLORS = {
  foreground: "#d7dae0",
  background: "#101216",
  "sideBar.background": "#15181d",
  "sideBar.foreground": "#cbd0d8",
  "sideBar.border": "#2b3038",
  "list.activeSelectionBackground": "#283445",
  "list.activeSelectionForeground": "#ffffff",
  "list.hoverBackground": "#20252d",
  "list.focusBackground": "#283445",
  focusBorder: "#6ea8fe",
  "gitDecoration.addedResourceForeground": "#67c587",
  "gitDecoration.modifiedResourceForeground": "#e6b85c",
  "gitDecoration.deletedResourceForeground": "#ef7a7a",
  "gitDecoration.untrackedResourceForeground": "#67c587",
  "gitDecoration.renamedResourceForeground": "#78a9ff",
};

const LIGHT_COLORS = {
  foreground: "#20242a",
  background: "#f4f5f7",
  "sideBar.background": "#ffffff",
  "sideBar.foreground": "#303640",
  "sideBar.border": "#d8dce2",
  "list.activeSelectionBackground": "#e7eef9",
  "list.activeSelectionForeground": "#17243a",
  "list.hoverBackground": "#f0f3f7",
  "list.focusBackground": "#e7eef9",
  focusBorder: "#356fc4",
  "gitDecoration.addedResourceForeground": "#267a45",
  "gitDecoration.modifiedResourceForeground": "#966d13",
  "gitDecoration.deletedResourceForeground": "#b33b3b",
  "gitDecoration.untrackedResourceForeground": "#267a45",
  "gitDecoration.renamedResourceForeground": "#356fc4",
};

export const HUNK_WEB_THEMES: Record<"dark" | "light", HunkWebTheme> = {
  dark: { name: "hunk-web-dark", type: "dark", diffs: "pierre-dark", colors: DARK_COLORS },
  light: { name: "hunk-web-light", type: "light", diffs: "pierre-light", colors: LIGHT_COLORS },
};
export const HUNK_WEB_THEME = HUNK_WEB_THEMES.dark;

/** Follow actual browser color-scheme changes so chrome and both Pierre surfaces switch together. */
export function useHunkWebTheme() {
  const type = useSyncExternalStore<"dark" | "light">(
    (notify) => {
      const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
      media?.addEventListener("change", notify);
      return () => media?.removeEventListener("change", notify);
    },
    () => (globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    () => "dark",
  );
  return HUNK_WEB_THEMES[type];
}

/** Translate the active palette into chrome CSS variables. */
export function hunkThemeCssVariables(theme: HunkWebTheme): CSSProperties {
  return {
    colorScheme: theme.type,
    "--hunk-bg": theme.colors.background,
    "--hunk-panel": theme.colors["sideBar.background"],
    "--hunk-raised": theme.type === "dark" ? "#1b1f25" : "#f8f9fb",
    "--hunk-fg": theme.colors.foreground,
    "--hunk-muted": theme.type === "dark" ? "#8f98a6" : "#68717d",
    "--hunk-border": theme.colors["sideBar.border"],
    "--hunk-selected": theme.colors["list.activeSelectionBackground"],
    "--hunk-accent": theme.colors.focusBorder,
    "--hunk-add": theme.colors["gitDecoration.addedResourceForeground"],
    "--hunk-delete": theme.colors["gitDecoration.deletedResourceForeground"],
  } as CSSProperties;
}

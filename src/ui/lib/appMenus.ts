import type { LayoutMode } from "../../core/types";
import type { MenuEntry, MenuId } from "../components/chrome/menu";
import { THEMES } from "../themes";

export interface BuildAppMenusOptions {
  activeThemeId: string;
  focusFiles: () => void;
  focusFilter: () => void;
  layoutMode: LayoutMode;
  moveAnnotatedFile: (delta: number) => void;
  moveHunk: (delta: number) => void;
  requestQuit: () => void;
  selectLayoutMode: (mode: LayoutMode) => void;
  selectThemeId: (themeId: string) => void;
  showAgentNotes: boolean;
  showHelp: boolean;
  showHunkHeaders: boolean;
  showLineNumbers: boolean;
  sidebarVisible: boolean;
  toggleAgentNotes: () => void;
  toggleHelp: () => void;
  toggleHunkHeaders: () => void;
  toggleLineNumbers: () => void;
  toggleLineWrap: () => void;
  toggleSidebar: () => void;
  wrapLines: boolean;
}

/** Build the top-level app menus from the current shell state and actions. */
export function buildAppMenus({
  activeThemeId,
  focusFiles,
  focusFilter,
  layoutMode,
  moveAnnotatedFile,
  moveHunk,
  requestQuit,
  selectLayoutMode,
  selectThemeId,
  showAgentNotes,
  showHelp,
  showHunkHeaders,
  showLineNumbers,
  sidebarVisible,
  toggleAgentNotes,
  toggleHelp,
  toggleHunkHeaders,
  toggleLineNumbers,
  toggleLineWrap,
  toggleSidebar,
  wrapLines,
}: BuildAppMenusOptions): Record<MenuId, MenuEntry[]> {
  const themeMenuEntries: MenuEntry[] = THEMES.map((theme) => ({
    kind: "item",
    label: theme.label,
    checked: theme.id === activeThemeId,
    action: () => selectThemeId(theme.id),
  }));

  return {
    file: [
      {
        kind: "item",
        label: "Focus files",
        hint: "Tab",
        action: focusFiles,
      },
      {
        kind: "item",
        label: "Focus filter",
        hint: "/",
        action: focusFilter,
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Quit",
        hint: "q",
        action: requestQuit,
      },
    ],
    view: [
      {
        kind: "item",
        label: "Split view",
        hint: "1",
        checked: layoutMode === "split",
        action: () => selectLayoutMode("split"),
      },
      {
        kind: "item",
        label: "Stacked view",
        hint: "2",
        checked: layoutMode === "stack",
        action: () => selectLayoutMode("stack"),
      },
      {
        kind: "item",
        label: "Auto layout",
        hint: "0",
        checked: layoutMode === "auto",
        action: () => selectLayoutMode("auto"),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Sidebar",
        hint: "s",
        checked: sidebarVisible,
        action: toggleSidebar,
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Agent notes",
        hint: "a",
        checked: showAgentNotes,
        action: toggleAgentNotes,
      },
      {
        kind: "item",
        label: "Line numbers",
        hint: "l",
        checked: showLineNumbers,
        action: toggleLineNumbers,
      },
      {
        kind: "item",
        label: "Line wrapping",
        hint: "w",
        checked: wrapLines,
        action: toggleLineWrap,
      },
      {
        kind: "item",
        label: "Hunk metadata",
        hint: "m",
        checked: showHunkHeaders,
        action: toggleHunkHeaders,
      },
    ],
    navigate: [
      {
        kind: "item",
        label: "Previous hunk",
        hint: "[",
        action: () => moveHunk(-1),
      },
      {
        kind: "item",
        label: "Next hunk",
        hint: "]",
        action: () => moveHunk(1),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Focus filter",
        hint: "/",
        action: focusFilter,
      },
    ],
    theme: themeMenuEntries,
    agent: [
      {
        kind: "item",
        label: "Agent notes",
        hint: "a",
        checked: showAgentNotes,
        action: toggleAgentNotes,
      },
      {
        kind: "item",
        label: "Next annotated file",
        action: () => moveAnnotatedFile(1),
      },
      {
        kind: "item",
        label: "Previous annotated file",
        action: () => moveAnnotatedFile(-1),
      },
    ],
    help: [
      {
        kind: "item",
        label: "Keyboard help",
        hint: "?",
        checked: showHelp,
        action: toggleHelp,
      },
    ],
  };
}

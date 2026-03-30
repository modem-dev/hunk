import type { LayoutMode } from "../../core/types";
import type { MenuEntry, MenuId } from "../components/chrome/menu";
import { THEMES } from "../themes";

export interface BuildAppMenusOptions {
  activeThemeId: string;
  canRefreshCurrentInput: boolean;
  focusFilter: () => void;
  layoutMode: LayoutMode;
  moveAnnotatedFile: (delta: number) => void;
  moveAnnotatedHunk: (delta: number) => void;
  moveHunk: (delta: number) => void;
  refreshCurrentInput: () => void;
  requestQuit: () => void;
  selectLayoutMode: (mode: LayoutMode) => void;
  selectThemeId: (themeId: string) => void;
  showAgentNotes: boolean;
  showHelp: boolean;
  showHunkHeaders: boolean;
  showLineNumbers: boolean;
  sidebarVisible: boolean;
  toggleAgentNotes: () => void;
  toggleFocusArea: () => void;
  toggleHelp: () => void;
  toggleHunkHeaders: () => void;
  toggleLineNumbers: () => void;
  toggleLineWrap: () => void;
  toggleSidebar: () => void;
  wrapLines: boolean;
}

/** Build the top-level app menus from the current app state and actions. */
export function buildAppMenus({
  activeThemeId,
  canRefreshCurrentInput,
  focusFilter,
  layoutMode,
  moveAnnotatedFile,
  moveAnnotatedHunk,
  moveHunk,
  refreshCurrentInput,
  requestQuit,
  selectLayoutMode,
  selectThemeId,
  showAgentNotes,
  showHelp,
  showHunkHeaders,
  showLineNumbers,
  sidebarVisible,
  toggleAgentNotes,
  toggleFocusArea,
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

  const fileMenuEntries: MenuEntry[] = [
    {
      kind: "item",
      label: "Toggle files/filter focus",
      hint: "Tab",
      action: toggleFocusArea,
    },
    {
      kind: "item",
      label: "Focus filter",
      hint: "/",
      action: focusFilter,
    },
  ];

  if (canRefreshCurrentInput) {
    fileMenuEntries.push({
      kind: "item",
      label: "Reload",
      hint: "r",
      action: refreshCurrentInput,
    });
  }

  fileMenuEntries.push(
    { kind: "separator" },
    {
      kind: "item",
      label: "Quit",
      hint: "q",
      action: requestQuit,
    },
  );

  return {
    file: fileMenuEntries,
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
        label: "Previous comment",
        hint: "{",
        action: () => moveAnnotatedHunk(-1),
      },
      {
        kind: "item",
        label: "Next comment",
        hint: "}",
        action: () => moveAnnotatedHunk(1),
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

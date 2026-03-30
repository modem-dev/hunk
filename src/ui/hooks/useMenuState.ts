import { useMemo } from "react";
import type { LayoutMode } from "../../core/types";
import type { MenuId } from "../components/chrome/menu";
import { buildAppMenus } from "../lib/appMenus";
import { useMenuController } from "./useMenuController";

interface UseMenuStateOptions {
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

/** Build the app menus from shell state and expose menu-controller interactions. */
export function useMenuState({
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
}: UseMenuStateOptions) {
  const menus = useMemo(
    () =>
      buildAppMenus({
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
      }),
    [
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
    ],
  );

  return useMenuController(menus as Record<MenuId, ReturnType<typeof buildAppMenus>[MenuId]>);
}

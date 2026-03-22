import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { LayoutMode } from "../../core/types";
import { MENU_ORDER, buildMenuSpecs, menuWidth, nextMenuItemIndex, type MenuEntry, type MenuId } from "../components/chrome/menu";
import { THEMES } from "../themes";

/** Build and drive the top-level desktop-style menu bar state. */
export function useMenuState({
  activeThemeId,
  focusFiles,
  focusFilter,
  layoutMode,
  moveAnnotatedFile,
  moveHunk,
  requestQuit,
  setLayoutMode,
  setShowHelp,
  setThemeId,
  showAgentNotes,
  showHelp,
  showHunkHeaders,
  showLineNumbers,
  sidebarVisible,
  toggleAgentNotes,
  toggleHunkHeaders,
  toggleLineNumbers,
  toggleLineWrap,
  toggleSidebar,
  wrapLines,
}: {
  activeThemeId: string;
  focusFiles: () => void;
  focusFilter: () => void;
  layoutMode: LayoutMode;
  moveAnnotatedFile: (delta: number) => void;
  moveHunk: (delta: number) => void;
  requestQuit: () => void;
  setLayoutMode: Dispatch<SetStateAction<LayoutMode>>;
  setShowHelp: Dispatch<SetStateAction<boolean>>;
  setThemeId: Dispatch<SetStateAction<string>>;
  showAgentNotes: boolean;
  showHelp: boolean;
  showHunkHeaders: boolean;
  showLineNumbers: boolean;
  sidebarVisible: boolean;
  toggleAgentNotes: () => void;
  toggleHunkHeaders: () => void;
  toggleLineNumbers: () => void;
  toggleLineWrap: () => void;
  toggleSidebar: () => void;
  wrapLines: boolean;
}) {
  const [activeMenuId, setActiveMenuId] = useState<MenuId | null>(null);
  const [activeMenuItemIndex, setActiveMenuItemIndex] = useState(0);

  const themeMenuEntries: MenuEntry[] = useMemo(
    () =>
      THEMES.map((theme) => ({
        kind: "item",
        label: theme.label,
        checked: theme.id === activeThemeId,
        action: () => {
          setThemeId(theme.id);
        },
      })),
    [activeThemeId, setThemeId],
  );

  const menus: Record<MenuId, MenuEntry[]> = useMemo(
    () => ({
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
          action: () => setLayoutMode("split"),
        },
        {
          kind: "item",
          label: "Stacked view",
          hint: "2",
          checked: layoutMode === "stack",
          action: () => setLayoutMode("stack"),
        },
        {
          kind: "item",
          label: "Auto layout",
          hint: "0",
          checked: layoutMode === "auto",
          action: () => setLayoutMode("auto"),
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
          action: () => setShowHelp((current) => !current),
        },
      ],
    }),
    [
      focusFiles,
      focusFilter,
      layoutMode,
      moveAnnotatedFile,
      moveHunk,
      requestQuit,
      setLayoutMode,
      setShowHelp,
      showAgentNotes,
      showHelp,
      showHunkHeaders,
      showLineNumbers,
      sidebarVisible,
      themeMenuEntries,
      toggleAgentNotes,
      toggleHunkHeaders,
      toggleLineNumbers,
      toggleLineWrap,
      toggleSidebar,
      wrapLines,
    ],
  );

  const closeMenu = () => {
    setActiveMenuId(null);
  };

  const openMenu = (menuId: MenuId) => {
    setActiveMenuId(menuId);
    setActiveMenuItemIndex(nextMenuItemIndex(menus[menuId], -1, 1));
  };

  const toggleMenu = (menuId: MenuId) => {
    if (activeMenuId === menuId) {
      closeMenu();
      return;
    }

    openMenu(menuId);
  };

  const switchMenu = (delta: number) => {
    const currentIndex = Math.max(0, activeMenuId ? MENU_ORDER.indexOf(activeMenuId) : 0);
    const nextIndex = (currentIndex + delta + MENU_ORDER.length) % MENU_ORDER.length;
    openMenu(MENU_ORDER[nextIndex]!);
  };

  const activateCurrentMenuItem = () => {
    if (!activeMenuId) {
      return;
    }

    const entry = menus[activeMenuId][activeMenuItemIndex];
    if (!entry || entry.kind !== "item") {
      return;
    }

    entry.action();
    closeMenu();
  };

  const menuSpecs = useMemo(() => buildMenuSpecs(), []);
  const activeMenuEntries = activeMenuId ? menus[activeMenuId] : [];
  const activeMenuSpec = menuSpecs.find((menu) => menu.id === activeMenuId);
  const activeMenuWidth = menuWidth(activeMenuEntries) + 2;

  return {
    activeMenuEntries,
    activeMenuId,
    activeMenuItemIndex,
    activeMenuSpec,
    activeMenuWidth,
    activateCurrentMenuItem,
    closeMenu,
    menuSpecs,
    openMenu,
    setActiveMenuItemIndex,
    switchMenu,
    toggleMenu,
  };
}

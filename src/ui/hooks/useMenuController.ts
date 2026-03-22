import { useMemo, useState } from "react";
import {
  MENU_ORDER,
  buildMenuSpecs,
  menuWidth,
  nextMenuItemIndex,
  type MenuEntry,
  type MenuId,
} from "../components/chrome/menu";

/** Drive menu selection/open state for the desktop-style top menu bar. */
export function useMenuController(menus: Record<MenuId, MenuEntry[]>) {
  const [activeMenuId, setActiveMenuId] = useState<MenuId | null>(null);
  const [activeMenuItemIndex, setActiveMenuItemIndex] = useState(0);

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

  const moveMenuItem = (delta: number) => {
    const entries = activeMenuId ? menus[activeMenuId] : [];
    setActiveMenuItemIndex((current) => nextMenuItemIndex(entries, current, delta));
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
    moveMenuItem,
    openMenu,
    setActiveMenuItemIndex,
    switchMenu,
    toggleMenu,
  };
}

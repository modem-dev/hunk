import { useMemo, useState } from "react";
import {
  buildMenuSpecs,
  menuEntries,
  menuWidth,
  nextMenuItemIndex,
  type AppMenus,
  type MenuId,
} from "../components/chrome/menu";

/** Drive menu selection/open state for the desktop-style top menu bar. */
export function useMenuController(menus: AppMenus) {
  const [activeMenuId, setActiveMenuId] = useState<MenuId | null>(null);
  const [activeMenuItemIndex, setActiveMenuItemIndex] = useState(0);

  const closeMenu = () => {
    setActiveMenuId(null);
  };

  const openMenu = (menuId: MenuId) => {
    setActiveMenuId(menuId);
    setActiveMenuItemIndex(nextMenuItemIndex(menuEntries(menus, menuId), -1, 1));
  };

  const toggleMenu = (menuId: MenuId) => {
    if (activeMenuId === menuId) {
      closeMenu();
      return;
    }

    openMenu(menuId);
  };

  const menuSpecs = useMemo(() => buildMenuSpecs(menus), [menus]);

  // Cycling walks the menus the bar actually shows, so a session without an
  // Extensions menu never lands on one that is not there.
  const switchMenu = (delta: number) => {
    if (menuSpecs.length === 0) {
      return;
    }

    const currentIndex = Math.max(
      0,
      activeMenuId ? menuSpecs.findIndex((menu) => menu.id === activeMenuId) : 0,
    );
    const nextIndex = (currentIndex + delta + menuSpecs.length) % menuSpecs.length;
    openMenu(menuSpecs[nextIndex]!.id);
  };

  const moveMenuItem = (delta: number) => {
    const entries = activeMenuId ? menuEntries(menus, activeMenuId) : [];
    setActiveMenuItemIndex((current) => nextMenuItemIndex(entries, current, delta));
  };

  const activateCurrentMenuItem = () => {
    if (!activeMenuId) {
      return;
    }

    const entry = menuEntries(menus, activeMenuId)[activeMenuItemIndex];
    if (!entry || entry.kind !== "item") {
      return;
    }

    entry.action();
    closeMenu();
  };

  const activeMenuEntries = activeMenuId ? menuEntries(menus, activeMenuId) : [];
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

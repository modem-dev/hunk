import { useEffect, useState } from "react";
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

  // Plain derivation, not a memo: `menus` is rebuilt every render on purpose
  // (hints and checked marks must stay live), so a memo keyed on it never hits.
  const menuSpecs = buildMenuSpecs(menus);

  // A menu can vanish while open — the Extensions menu disappears when a
  // session reload drops the last registered extension command. The stored id
  // counts as closed the moment its spec is gone, so the bar never holds an
  // invisible "open" menu that swallows the next F10 press.
  const openMenuId =
    activeMenuId !== null && menuSpecs.some((menu) => menu.id === activeMenuId)
      ? activeMenuId
      : null;

  // Also clear the stale id, so the menu does not spring back open if a later
  // reload re-registers the commands that bring its spec back.
  useEffect(() => {
    if (activeMenuId !== null && openMenuId === null) {
      setActiveMenuId(null);
    }
  }, [activeMenuId, openMenuId]);

  const closeMenu = () => {
    setActiveMenuId(null);
  };

  const openMenu = (menuId: MenuId) => {
    setActiveMenuId(menuId);
    setActiveMenuItemIndex(nextMenuItemIndex(menuEntries(menus, menuId), -1, 1));
  };

  const toggleMenu = (menuId: MenuId) => {
    if (openMenuId === menuId) {
      closeMenu();
      return;
    }

    openMenu(menuId);
  };

  // Cycling walks the menus the bar actually shows, so a session without an
  // Extensions menu never lands on one that is not there.
  const switchMenu = (delta: number) => {
    if (menuSpecs.length === 0) {
      return;
    }

    const currentIndex = Math.max(
      0,
      openMenuId ? menuSpecs.findIndex((menu) => menu.id === openMenuId) : 0,
    );
    const nextIndex = (currentIndex + delta + menuSpecs.length) % menuSpecs.length;
    openMenu(menuSpecs[nextIndex]!.id);
  };

  const moveMenuItem = (delta: number) => {
    const entries = openMenuId ? menuEntries(menus, openMenuId) : [];
    setActiveMenuItemIndex((current) => nextMenuItemIndex(entries, current, delta));
  };

  const activateCurrentMenuItem = () => {
    if (!openMenuId) {
      return;
    }

    const entry = menuEntries(menus, openMenuId)[activeMenuItemIndex];
    if (!entry || entry.kind !== "item") {
      return;
    }

    entry.action();
    closeMenu();
  };

  const activeMenuEntries = openMenuId ? menuEntries(menus, openMenuId) : [];
  const activeMenuSpec = menuSpecs.find((menu) => menu.id === openMenuId);
  const activeMenuWidth = menuWidth(activeMenuEntries) + 2;

  return {
    activeMenuEntries,
    activeMenuId: openMenuId,
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

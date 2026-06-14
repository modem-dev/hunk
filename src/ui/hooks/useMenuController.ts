import { type Accessor, createMemo, createSignal } from "solid-js";
import {
  buildMenuSpecs,
  type MenuEntry,
  type MenuId,
  MENU_ORDER,
  menuWidth,
  nextMenuItemIndex,
} from "../components/chrome/menu";

/**
 * Drive menu selection/open state for the desktop-style top menu bar.
 *
 * `menus` is an accessor so menu contents stay current as review state changes. The returned
 * state fields (`activeMenuId`, `activeMenuItemIndex`, and the derived specs/width/entries) are
 * accessors — call them in a tracking scope to react to open/close and navigation.
 */
export function useMenuController(menus: Accessor<Record<MenuId, MenuEntry[]>>) {
  const [activeMenuId, setActiveMenuId] = createSignal<MenuId | null>(null);
  const [activeMenuItemIndex, setActiveMenuItemIndex] = createSignal(0);

  const closeMenu = () => {
    setActiveMenuId(null);
  };

  const openMenu = (menuId: MenuId) => {
    setActiveMenuId(menuId);
    setActiveMenuItemIndex(nextMenuItemIndex(menus()[menuId], -1, 1));
  };

  const toggleMenu = (menuId: MenuId) => {
    if (activeMenuId() === menuId) {
      closeMenu();
      return;
    }

    openMenu(menuId);
  };

  const switchMenu = (delta: number) => {
    const active = activeMenuId();
    const currentIndex = Math.max(0, active ? MENU_ORDER.indexOf(active) : 0);
    const nextIndex = (currentIndex + delta + MENU_ORDER.length) % MENU_ORDER.length;
    openMenu(MENU_ORDER[nextIndex]!);
  };

  const moveMenuItem = (delta: number) => {
    const active = activeMenuId();
    const entries = active ? menus()[active] : [];
    setActiveMenuItemIndex((current) => nextMenuItemIndex(entries, current, delta));
  };

  const activateCurrentMenuItem = () => {
    const active = activeMenuId();
    if (!active) {
      return;
    }

    const entry = menus()[active][activeMenuItemIndex()];
    if (!entry || entry.kind !== "item") {
      return;
    }

    entry.action();
    closeMenu();
  };

  // Menu specs are static for the session (was useMemo with empty deps).
  const menuSpecs = buildMenuSpecs();
  const activeMenuEntries = createMemo<MenuEntry[]>(() => {
    const active = activeMenuId();
    return active ? menus()[active] : [];
  });
  const activeMenuSpec = createMemo(() => menuSpecs.find((menu) => menu.id === activeMenuId()));
  const activeMenuWidth = createMemo(() => menuWidth(activeMenuEntries()) + 2);

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

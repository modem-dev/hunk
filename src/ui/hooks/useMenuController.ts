import { useEffect, useRef, useState } from "react";
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
  // OpenTUI can deliver several decoded keys before React commits a render.
  // These mirrors preserve sequential menu semantics within that input burst.
  const liveMenuId = useRef<MenuId | null>(activeMenuId);
  const liveItemIndex = useRef(activeMenuItemIndex);
  const liveMenus = useRef(menus);
  liveMenuId.current = activeMenuId;
  liveItemIndex.current = activeMenuItemIndex;
  liveMenus.current = menus;

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
    liveMenuId.current = null;
    setActiveMenuId(null);
  };

  const openMenu = (menuId: MenuId) => {
    const firstIndex = nextMenuItemIndex(menuEntries(liveMenus.current, menuId), -1, 1);
    liveMenuId.current = menuId;
    liveItemIndex.current = firstIndex;
    setActiveMenuId(menuId);
    setActiveMenuItemIndex(firstIndex);
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

    const currentMenuId = liveMenuId.current;
    const currentIndex = Math.max(
      0,
      currentMenuId ? menuSpecs.findIndex((menu) => menu.id === currentMenuId) : 0,
    );
    const nextIndex = (currentIndex + delta + menuSpecs.length) % menuSpecs.length;
    openMenu(menuSpecs[nextIndex]!.id);
  };

  const activeMenuEntries = openMenuId ? menuEntries(menus, openMenuId) : [];

  // An open menu's entries can also change under the highlight — a watch
  // reload adds "Reload", extension commands re-register — leaving the stored
  // positional index on a separator, a shifted row, or past the end. Resolve
  // a stored index to the nearest selectable item of the list as it is now,
  // so the visible highlight and Enter always agree on a real entry.
  const resolveItemIndex = (index: number) => {
    const entry = activeMenuEntries[index];
    return entry?.kind === "item" && !entry.disabled
      ? index
      : nextMenuItemIndex(activeMenuEntries, Math.min(index, activeMenuEntries.length) - 1, 1);
  };

  const openMenuItemIndex = resolveItemIndex(activeMenuItemIndex);

  // Write the resolved index back so later steps start from where the
  // highlight visibly is, not from the stale position.
  useEffect(() => {
    if (openMenuId !== null && openMenuItemIndex !== activeMenuItemIndex) {
      liveItemIndex.current = openMenuItemIndex;
      setActiveMenuItemIndex(openMenuItemIndex);
    }
  }, [openMenuId, openMenuItemIndex, activeMenuItemIndex]);

  const moveMenuItem = (delta: number) => {
    const menuId = liveMenuId.current;
    const entries = menuId ? menuEntries(liveMenus.current, menuId) : [];
    const next = nextMenuItemIndex(entries, liveItemIndex.current, delta);
    liveItemIndex.current = next;
    setActiveMenuItemIndex(next);
  };

  const activateCurrentMenuItem = () => {
    const menuId = liveMenuId.current;
    const entries = menuId ? menuEntries(liveMenus.current, menuId) : [];
    const entry = entries[liveItemIndex.current];
    if (!entry || entry.kind !== "item" || entry.disabled) {
      return;
    }

    entry.action();
    closeMenu();
  };

  const activeMenuSpec = menuSpecs.find((menu) => menu.id === openMenuId);
  const activeMenuWidth = menuWidth(activeMenuEntries) + 2;

  return {
    activeMenuEntries,
    activeMenuId: openMenuId,
    activeMenuItemIndex: openMenuItemIndex,
    activeMenuSpec,
    activeMenuWidth,
    activateCurrentMenuItem,
    closeMenu,
    getActiveMenuId: () => liveMenuId.current,
    menuSpecs,
    moveMenuItem,
    openMenu,
    setActiveMenuItemIndex,
    switchMenu,
    toggleMenu,
  };
}

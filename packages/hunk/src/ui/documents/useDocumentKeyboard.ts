import { useKeyboard } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import type { useMenuController } from "../hooks/useMenuController";
import type { useThemeSelectorController } from "../hooks/useThemeSelectorController";
import { dispatchAppCommand, type AppCommand } from "../lib/appCommands";

type MenuController = ReturnType<typeof useMenuController>;
type ThemeSelectorController = ReturnType<typeof useThemeSelectorController>;

/** Route theme-selector keys without granting document commands while the selector is open. */
function handleThemeKey(key: KeyEvent, selector: ThemeSelectorController) {
  const actions: Record<string, () => void> = {
    escape: selector.closeThemeSelector,
    up: () => selector.moveThemeSelector(-1),
    down: () => selector.moveThemeSelector(1),
    return: selector.acceptThemeSelector,
  };

  actions[key.name]?.();
}

/** Route open-menu navigation independently of document focus. */
function handleMenuKey(key: KeyEvent, menu: MenuController) {
  const actions: Record<string, () => void> = {
    escape: menu.closeMenu,
    left: () => menu.switchMenu(-1),
    right: () => menu.switchMenu(1),
    up: () => menu.moveMenuItem(-1),
    down: () => menu.moveMenuItem(1),
    return: menu.activateCurrentMenuItem,
  };

  actions[key.name]?.();
}

/** Give help, themes and menus keyboard priority before dispatching document commands. */
export function useDocumentKeyboard({
  help,
  closeHelp,
  themeSelector,
  menu,
  commands,
}: {
  help: boolean;
  closeHelp: () => void;
  themeSelector: ThemeSelectorController;
  menu: MenuController;
  commands: readonly AppCommand[];
}) {
  useKeyboard((key) => {
    if (help) {
      if (key.name === "escape" || key.sequence === "?") {
        closeHelp();
        key.preventDefault();
      }
      // The focused help scrollbox owns navigation; document commands remain blocked.
      return;
    }

    if (themeSelector.themeSelectorOpen) {
      handleThemeKey(key, themeSelector);
    } else if (key.name === "f10") {
      if (menu.activeMenuId) menu.closeMenu();
      else menu.openMenu("file");
    } else if (menu.getActiveMenuId()) {
      handleMenuKey(key, menu);
    } else {
      dispatchAppCommand(commands, key);
      return;
    }
    key.preventDefault();
  });
}

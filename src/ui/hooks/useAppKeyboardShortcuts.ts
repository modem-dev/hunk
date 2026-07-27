import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRef } from "react";
import type { MenuId } from "../components/chrome/menu";
import { dispatchAppCommand, type AppCommand } from "../lib/appCommands";
import { isEscapeKey, isSaveDraftNoteKey } from "../lib/keyboard";

type FocusArea = "files" | "filter" | "note";

export interface UseAppKeyboardShortcutsOptions {
  activeMenuId: MenuId | null;
  activateCurrentMenuItem: () => void;
  closeAgentSkill: () => void;
  closeHelp: () => void;
  closeMenu: () => void;
  acceptThemeSelector: () => void;
  cancelDraftNote: () => void;
  closeThemeSelector: () => void;
  closeExtensionTrustPrompt: () => void;
  /**
   * Every app-level shortcut, built-in and extension-contributed, in dispatch
   * order. Modal navigation stays in this hook; commands own the rest.
   */
  commands: readonly AppCommand[];
  denyRepoExtensions: () => void;
  extensionTrustPromptOpen: boolean;
  trustRepoExtensions: () => void;
  focusArea: FocusArea;
  moveMenuItem: (delta: number) => void;
  moveThemeSelector: (delta: number) => void;
  openMenu: (menuId: MenuId) => void;
  pagerMode: boolean;
  saveConfigPromptOpen: boolean;
  saveViewPreferencesAndQuit: () => void;
  discardViewPreferencesAndQuit: () => void;
  neverAskToSaveViewPreferencesAndQuit: () => void;
  closeSaveConfigPrompt: () => void;
  saveDraftNote: () => void;
  showAgentSkill: boolean;
  showHelp: boolean;
  switchMenu: (delta: number) => void;
  toggleFocusArea: () => void;
  themeSelectorOpen: boolean;
}

/**
 * Register the app's scoped keyboard handling while keeping mode precedence
 * explicit.
 *
 * Modal surfaces (the trust prompt, save-config prompt, dialogs, the theme
 * selector, open menus, focused text inputs) answer first, in a fixed order —
 * their keys are the structure of the widget that owns them. Everything that
 * falls through lands in the command table, where built-in shortcuts and
 * extension commands share one dispatch path.
 */
export function useAppKeyboardShortcuts({
  activeMenuId,
  activateCurrentMenuItem,
  closeAgentSkill,
  closeHelp,
  closeMenu,
  acceptThemeSelector,
  cancelDraftNote,
  closeThemeSelector,
  closeExtensionTrustPrompt,
  commands,
  denyRepoExtensions,
  extensionTrustPromptOpen,
  trustRepoExtensions,
  focusArea,
  moveMenuItem,
  moveThemeSelector,
  openMenu,
  pagerMode,
  saveConfigPromptOpen,
  saveViewPreferencesAndQuit,
  discardViewPreferencesAndQuit,
  neverAskToSaveViewPreferencesAndQuit,
  closeSaveConfigPrompt,
  saveDraftNote,
  showAgentSkill,
  showHelp,
  switchMenu,
  toggleFocusArea,
  themeSelectorOpen,
}: UseAppKeyboardShortcutsOptions) {
  const activeMenuIdRef = useRef(activeMenuId);
  const commandsRef = useRef(commands);
  const focusAreaRef = useRef(focusArea);
  const pagerModeRef = useRef(pagerMode);
  const showAgentSkillRef = useRef(showAgentSkill);
  const showHelpRef = useRef(showHelp);
  const saveConfigPromptOpenRef = useRef(saveConfigPromptOpen);
  const themeSelectorOpenRef = useRef(themeSelectorOpen);
  const extensionTrustPromptOpenRef = useRef(extensionTrustPromptOpen);

  activeMenuIdRef.current = activeMenuId;
  commandsRef.current = commands;
  focusAreaRef.current = focusArea;
  pagerModeRef.current = pagerMode;
  showAgentSkillRef.current = showAgentSkill;
  showHelpRef.current = showHelp;
  saveConfigPromptOpenRef.current = saveConfigPromptOpen;
  themeSelectorOpenRef.current = themeSelectorOpen;
  extensionTrustPromptOpenRef.current = extensionTrustPromptOpen;

  const consumeKey = (key: KeyEvent) => {
    key.preventDefault();
    key.stopPropagation();
  };

  const handleMenuToggleShortcut = (key: KeyEvent) => {
    if (key.name !== "f10") {
      return false;
    }

    if (pagerModeRef.current) {
      return true;
    }

    if (activeMenuIdRef.current) {
      closeMenu();
    } else {
      openMenu("file");
    }

    return true;
  };

  const handleDialogShortcut = (key: KeyEvent) => {
    if (!isEscapeKey(key)) {
      return false;
    }

    if (showAgentSkillRef.current) {
      closeAgentSkill();
      return true;
    }

    if (showHelpRef.current) {
      closeHelp();
      return true;
    }

    return false;
  };

  const handleSaveConfigPromptShortcut = (key: KeyEvent) => {
    if (!saveConfigPromptOpenRef.current) {
      return false;
    }

    consumeKey(key);
    if (key.name === "return" || key.name === "enter" || key.name === "s" || key.sequence === "s") {
      saveViewPreferencesAndQuit();
      return true;
    }

    // "q" again quits and discards, so a double-tap of the quit key always exits.
    if (key.name === "q" || key.sequence === "q") {
      discardViewPreferencesAndQuit();
      return true;
    }

    if (key.name === "n" || key.sequence === "n") {
      neverAskToSaveViewPreferencesAndQuit();
      return true;
    }

    if (isEscapeKey(key)) {
      closeSaveConfigPrompt();
      return true;
    }

    return true;
  };

  /**
   * Own every key while the repo-extension trust prompt is up.
   *
   * The prompt is a security decision, so no key may fall through to review
   * navigation and leave it ambiguous which choice the user just made. Escape
   * is deliberately the same as "not now": dismiss, persist nothing.
   */
  const handleExtensionTrustPromptShortcut = (key: KeyEvent) => {
    if (!extensionTrustPromptOpenRef.current) {
      return false;
    }

    consumeKey(key);
    if (key.name === "return" || key.name === "enter" || key.name === "t" || key.sequence === "t") {
      trustRepoExtensions();
      return true;
    }

    if (key.name === "n" || key.sequence === "n") {
      denyRepoExtensions();
      return true;
    }

    if (isEscapeKey(key)) {
      closeExtensionTrustPrompt();
      return true;
    }

    return true;
  };

  const handleThemeSelectorShortcut = (key: KeyEvent) => {
    if (!themeSelectorOpenRef.current) {
      return false;
    }

    if (isEscapeKey(key)) {
      consumeKey(key);
      closeThemeSelector();
      return true;
    }

    if (key.name === "up") {
      consumeKey(key);
      moveThemeSelector(-1);
      return true;
    }

    if (key.name === "down") {
      consumeKey(key);
      moveThemeSelector(1);
      return true;
    }

    if (key.name === "tab") {
      consumeKey(key);
      moveThemeSelector(key.shift ? -1 : 1);
      return true;
    }

    if (key.name === "return" || key.name === "enter") {
      consumeKey(key);
      acceptThemeSelector();
      return true;
    }

    return true;
  };

  const handleMenuShortcut = (key: KeyEvent) => {
    if (!activeMenuIdRef.current) {
      return false;
    }

    if (isEscapeKey(key)) {
      closeMenu();
      return true;
    }

    if (key.name === "left") {
      switchMenu(-1);
      return true;
    }

    if (key.name === "right" || key.name === "tab") {
      switchMenu(1);
      return true;
    }

    if (key.name === "up") {
      moveMenuItem(-1);
      return true;
    }

    if (key.name === "down") {
      moveMenuItem(1);
      return true;
    }

    if (key.name === "return" || key.name === "enter") {
      activateCurrentMenuItem();
      return true;
    }

    return false;
  };

  const handleFocusedInputShortcut = (key: KeyEvent) => {
    if (focusAreaRef.current === "filter") {
      if (key.name === "tab") {
        toggleFocusArea();
        return true;
      }

      // Let the focused input own filter editing and escape handling.
      return true;
    }

    if (focusAreaRef.current !== "note") {
      return false;
    }

    if (isEscapeKey(key)) {
      consumeKey(key);
      cancelDraftNote();
      return true;
    }

    if (isSaveDraftNoteKey(key)) {
      consumeKey(key);
      saveDraftNote();
      return true;
    }

    // Let the focused inline note input own text editing.
    return true;
  };

  useKeyboard((key: KeyEvent) => {
    if (handleExtensionTrustPromptShortcut(key)) {
      return;
    }

    if (handleSaveConfigPromptShortcut(key)) {
      return;
    }

    if (handleMenuToggleShortcut(key)) {
      return;
    }

    if (handleDialogShortcut(key)) {
      return;
    }

    if (handleThemeSelectorShortcut(key)) {
      return;
    }

    if (handleMenuShortcut(key)) {
      return;
    }

    if (handleFocusedInputShortcut(key)) {
      return;
    }

    const matched = dispatchAppCommand(
      commandsRef.current,
      pagerModeRef.current ? "pager" : "review",
      key,
    );
    if (matched?.closesMenu) {
      closeMenu();
    }
  });
}

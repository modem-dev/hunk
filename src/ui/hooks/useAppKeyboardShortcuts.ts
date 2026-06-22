import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRef } from "react";
import {
  isCreateReviewNoteKey,
  isEscapeKey,
  isSaveDraftNoteKey,
} from "../../core/keyboard";
import type { ActionId, ActionScope } from "../../core/keymap/actions";
import type { Keymap } from "../../core/keymap/match";
import { matchesAction } from "../../core/keymap/match";
import type { LayoutMode } from "../../core/types";
import type { MenuId } from "../components/chrome/menu";

type FocusArea = "files" | "filter" | "note";
type ScrollUnit = "step" | "viewport" | "content" | "half";

const FAST_CODE_HORIZONTAL_SCROLL_COLUMNS = 8;

export interface UseAppKeyboardShortcutsOptions {
  activeMenuId: MenuId | null;
  activateCurrentMenuItem: () => void;
  acceptThemeSelector: () => void;
  cancelDraftNote: () => void;
  canRefreshCurrentInput: boolean;
  closeAgentSkill: () => void;
  closeHelp: () => void;
  closeMenu: () => void;
  closeThemeSelector: () => void;
  focusArea: FocusArea;
  focusFilter: () => void;
  keymap: Keymap;
  moveToAnnotatedHunk: (delta: number) => void;
  moveToFile: (delta: number) => void;
  moveToHunk: (delta: number) => void;
  moveMenuItem: (delta: number) => void;
  moveThemeSelector: (delta: number) => void;
  openMenu: (menuId: MenuId) => void;
  openThemeSelector: () => void;
  pagerMode: boolean;
  requestQuit: () => void;
  saveDraftNote: () => void;
  scrollCodeHorizontally: (delta: number) => void;
  scrollDiff: (delta: number, unit: ScrollUnit) => void;
  selectLayoutMode: (mode: LayoutMode) => void;
  showAgentSkill: boolean;
  showHelp: boolean;
  startUserNote: () => void;
  switchMenu: (delta: number) => void;
  themeSelectorOpen: boolean;
  toggleAgentNotes: () => void;
  toggleFocusArea: () => void;
  toggleGapForSelectedHunk: () => void;
  toggleHelp: () => void;
  toggleHunkHeaders: () => void;
  toggleLineNumbers: () => void;
  toggleLineWrap: () => void;
  toggleSidebar: () => void;
  triggerEditSelectedFile: () => void;
  triggerRefreshCurrentInput: () => void;
}

/** Register the app's scoped keyboard handling while keeping mode precedence explicit. */
export function useAppKeyboardShortcuts({
  activeMenuId,
  activateCurrentMenuItem,
  acceptThemeSelector,
  cancelDraftNote,
  canRefreshCurrentInput,
  closeAgentSkill,
  closeHelp,
  closeMenu,
  closeThemeSelector,
  focusArea,
  focusFilter,
  keymap,
  moveToAnnotatedHunk,
  moveToFile,
  moveToHunk,
  moveMenuItem,
  moveThemeSelector,
  openMenu,
  openThemeSelector,
  pagerMode,
  requestQuit,
  saveDraftNote,
  scrollCodeHorizontally,
  scrollDiff,
  selectLayoutMode,
  showAgentSkill,
  showHelp,
  startUserNote,
  switchMenu,
  themeSelectorOpen,
  toggleAgentNotes,
  toggleFocusArea,
  toggleGapForSelectedHunk,
  toggleHelp,
  toggleHunkHeaders,
  toggleLineNumbers,
  toggleLineWrap,
  toggleSidebar,
  triggerEditSelectedFile,
  triggerRefreshCurrentInput,
}: UseAppKeyboardShortcutsOptions) {
  const activeMenuIdRef = useRef(activeMenuId);
  const focusAreaRef = useRef(focusArea);
  const pagerModeRef = useRef(pagerMode);
  const showAgentSkillRef = useRef(showAgentSkill);
  const showHelpRef = useRef(showHelp);
  const themeSelectorOpenRef = useRef(themeSelectorOpen);
  const keymapRef = useRef(keymap);

  activeMenuIdRef.current = activeMenuId;
  focusAreaRef.current = focusArea;
  pagerModeRef.current = pagerMode;
  showAgentSkillRef.current = showAgentSkill;
  showHelpRef.current = showHelp;
  themeSelectorOpenRef.current = themeSelectorOpen;
  keymapRef.current = keymap;

  const runAndCloseMenu = (action: () => void) => {
    action();
    closeMenu();
  };

  const consumeKey = (key: KeyEvent) => {
    key.preventDefault();
    key.stopPropagation();
  };

  const isAction = (scope: ActionScope, id: ActionId, key: KeyEvent) =>
    matchesAction(keymapRef.current, scope, id, key);

  const handleMenuToggleShortcut = (key: KeyEvent) => {
    if (!isAction("global", "menu.open", key)) {
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

  const handlePagerShortcut = (key: KeyEvent) => {
    if (isAction("pager", "quit", key)) {
      requestQuit();
      return;
    }

    // pageUp must be queried before pageDown (see match.test.ts "Shift+Space
    // page-up precedence"). Same pattern repeats for codeLeftFast/codeRightFast.
    if (isAction("pager", "scroll.pageUp", key)) {
      scrollDiff(-1, "viewport");
      return;
    }

    if (isAction("pager", "scroll.pageDown", key)) {
      scrollDiff(1, "viewport");
      return;
    }

    if (isAction("pager", "scroll.halfPageDown", key)) {
      scrollDiff(1, "half");
      return;
    }

    if (isAction("pager", "scroll.halfPageUp", key)) {
      scrollDiff(-1, "half");
      return;
    }

    if (isAction("pager", "scroll.lineDown", key)) {
      scrollDiff(1, "step");
      return;
    }

    if (isAction("pager", "scroll.lineUp", key)) {
      scrollDiff(-1, "step");
      return;
    }

    if (isAction("pager", "scroll.codeLeftFast", key)) {
      scrollCodeHorizontally(-FAST_CODE_HORIZONTAL_SCROLL_COLUMNS);
      return;
    }

    if (isAction("pager", "scroll.codeRightFast", key)) {
      scrollCodeHorizontally(FAST_CODE_HORIZONTAL_SCROLL_COLUMNS);
      return;
    }

    if (isAction("pager", "scroll.codeLeft", key)) {
      scrollCodeHorizontally(-1);
      return;
    }

    if (isAction("pager", "scroll.codeRight", key)) {
      scrollCodeHorizontally(1);
      return;
    }

    if (isAction("pager", "scroll.toTop", key)) {
      scrollDiff(-1, "content");
      return;
    }

    if (isAction("pager", "scroll.toBottom", key)) {
      scrollDiff(1, "content");
      return;
    }

    if (isAction("pager", "wrap.toggle", key)) {
      toggleLineWrap();
      return;
    }

    if (isAction("pager", "sidebar.toggle", key)) {
      toggleSidebar();
    }
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

  const handleHelpShortcut = (key: KeyEvent) => {
    if (!showHelpRef.current) return false;
    // Only Esc and the help-toggle binding close help here. Other keys (notably
    // `quit`) fall through so they continue to fire their app-level handlers.
    if (!isEscapeKey(key) && !isAction("global", "help.toggle", key)) return false;
    closeHelp();
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

    if (isAction("menu", "menu.close", key)) {
      closeMenu();
      return true;
    }

    if (isAction("menu", "menu.prev", key)) {
      switchMenu(-1);
      return true;
    }

    if (isAction("menu", "menu.next", key)) {
      switchMenu(1);
      return true;
    }

    if (isAction("menu", "menu.itemUp", key)) {
      moveMenuItem(-1);
      return true;
    }

    if (isAction("menu", "menu.itemDown", key)) {
      moveMenuItem(1);
      return true;
    }

    if (isAction("menu", "menu.activate", key)) {
      activateCurrentMenuItem();
      return true;
    }

    return false;
  };

  const handleFocusedInputShortcut = (key: KeyEvent) => {
    if (focusAreaRef.current === "filter") {
      if (isAction("filter", "focus.toggle", key)) {
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

  const handleAppShortcut = (key: KeyEvent) => {
    if (isAction("global", "quit", key)) {
      requestQuit();
      return;
    }

    if (isAction("global", "help.toggle", key)) {
      toggleHelp();
      closeMenu();
      return;
    }

    if (isAction("global", "focus.toggle", key)) {
      toggleFocusArea();
      return;
    }

    if (isAction("global", "filter.focus", key)) {
      focusFilter();
      return;
    }

    // `c` is matched with strict modifier rules so terminal copy chords don't
    // start a note. Not routed through the modifier-permissive keymap matcher.
    if (isCreateReviewNoteKey(key)) {
      runAndCloseMenu(startUserNote);
      return;
    }

    if (isAction("global", "scroll.pageUp", key)) {
      scrollDiff(-1, "viewport");
      return;
    }

    if (isAction("global", "scroll.pageDown", key)) {
      scrollDiff(1, "viewport");
      return;
    }

    if (isAction("global", "scroll.halfPageDown", key)) {
      scrollDiff(1, "half");
      return;
    }

    if (isAction("global", "scroll.halfPageUp", key)) {
      scrollDiff(-1, "half");
      return;
    }

    if (isAction("global", "scroll.toTop", key)) {
      scrollDiff(-1, "content");
      return;
    }

    if (isAction("global", "scroll.toBottom", key)) {
      scrollDiff(1, "content");
      return;
    }

    if (isAction("global", "scroll.lineUp", key)) {
      scrollDiff(-1, "step");
      return;
    }

    if (isAction("global", "scroll.lineDown", key)) {
      scrollDiff(1, "step");
      return;
    }

    if (isAction("global", "scroll.codeLeftFast", key)) {
      scrollCodeHorizontally(-FAST_CODE_HORIZONTAL_SCROLL_COLUMNS);
      return;
    }

    if (isAction("global", "scroll.codeRightFast", key)) {
      scrollCodeHorizontally(FAST_CODE_HORIZONTAL_SCROLL_COLUMNS);
      return;
    }

    if (isAction("global", "scroll.codeLeft", key)) {
      scrollCodeHorizontally(-1);
      return;
    }

    if (isAction("global", "scroll.codeRight", key)) {
      scrollCodeHorizontally(1);
      return;
    }

    if (isAction("global", "layout.split", key)) {
      runAndCloseMenu(() => selectLayoutMode("split"));
      return;
    }

    if (isAction("global", "layout.stack", key)) {
      runAndCloseMenu(() => selectLayoutMode("stack"));
      return;
    }

    if (isAction("global", "layout.auto", key)) {
      runAndCloseMenu(() => selectLayoutMode("auto"));
      return;
    }

    if (isAction("global", "sidebar.toggle", key)) {
      runAndCloseMenu(toggleSidebar);
      return;
    }

    if (isAction("global", "reload", key) && canRefreshCurrentInput) {
      runAndCloseMenu(triggerRefreshCurrentInput);
      return;
    }

    if (isAction("global", "theme.cycle", key)) {
      runAndCloseMenu(openThemeSelector);
      return;
    }

    if (isAction("global", "agentNotes.toggle", key)) {
      runAndCloseMenu(toggleAgentNotes);
      return;
    }

    if (isAction("global", "lineNumbers.toggle", key)) {
      runAndCloseMenu(toggleLineNumbers);
      return;
    }

    if (isAction("global", "wrap.toggle", key)) {
      runAndCloseMenu(toggleLineWrap);
      return;
    }

    if (isAction("global", "hunkHeaders.toggle", key)) {
      runAndCloseMenu(toggleHunkHeaders);
      return;
    }

    if (isAction("global", "hunk.prev", key)) {
      runAndCloseMenu(() => moveToHunk(-1));
      return;
    }

    if (isAction("global", "hunk.next", key)) {
      runAndCloseMenu(() => moveToHunk(1));
      return;
    }

    if (isAction("global", "file.prev", key)) {
      runAndCloseMenu(() => moveToFile(-1));
      return;
    }

    if (isAction("global", "file.next", key)) {
      runAndCloseMenu(() => moveToFile(1));
      return;
    }

    if (isAction("global", "annotatedHunk.prev", key)) {
      runAndCloseMenu(() => moveToAnnotatedHunk(-1));
      return;
    }

    if (isAction("global", "annotatedHunk.next", key)) {
      runAndCloseMenu(() => moveToAnnotatedHunk(1));
      return;
    }

    if (isAction("global", "hunk.toggleGap", key)) {
      runAndCloseMenu(toggleGapForSelectedHunk);
      return;
    }

    if (isAction("global", "file.edit", key)) {
      runAndCloseMenu(triggerEditSelectedFile);
    }
  };

  useKeyboard((key: KeyEvent) => {
    if (handleMenuToggleShortcut(key)) {
      return;
    }

    if (pagerModeRef.current) {
      handlePagerShortcut(key);
      return;
    }

    if (handleDialogShortcut(key)) {
      return;
    }

    if (handleHelpShortcut(key)) {
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

    handleAppShortcut(key);
  });
}

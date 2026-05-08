import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRef } from "react";
import type { LayoutMode } from "../../core/types";
import type { MenuId } from "../components/chrome/menu";
import {
  isEscapeKey,
  isHalfPageDownKey,
  isHalfPageUpKey,
  isPageDownKey,
  isPageUpKey,
  isShiftSpacePageUpKey,
  isStepDownKey,
  isStepUpKey,
} from "../lib/keyboard";

type FocusArea = "files" | "filter";
type ScrollUnit = "step" | "viewport" | "content" | "half";

const FAST_CODE_HORIZONTAL_SCROLL_COLUMNS = 8;

export interface UseAppKeyboardShortcutsOptions {
  activeMenuId: MenuId | null;
  activateCurrentMenuItem: () => void;
  canRefreshCurrentInput: boolean;
  closeHelp: () => void;
  closeMenu: () => void;
  cycleTheme: () => void;
  focusArea: FocusArea;
  focusFilter: () => void;
  moveToAnnotatedHunk: (delta: number) => void;
  moveToHunk: (delta: number) => void;
  moveMenuItem: (delta: number) => void;
  openMenu: (menuId: MenuId) => void;
  pagerMode: boolean;
  /**
   * Optional commit-cursor handler for `git log -p` style sessions. Triggered by
   * Ctrl-N (next) and Ctrl-P (previous). Returns false to indicate the move was
   * blocked (e.g., pending confirmation) so the handler can stay reserved.
   */
  requestMoveCommit?: (delta: number) => void;
  /** When true, the next key press is interpreted as a confirmation answer. */
  pendingCommitConfirmation?: boolean;
  onConfirmCommitMove?: () => void;
  onCancelCommitMove?: () => void;
  requestQuit: () => void;
  scrollCodeHorizontally: (delta: number) => void;
  scrollDiff: (delta: number, unit: ScrollUnit) => void;
  selectLayoutMode: (mode: LayoutMode) => void;
  showHelp: boolean;
  switchMenu: (delta: number) => void;
  toggleAgentNotes: () => void;
  /** Optional: only present in commit-review sessions where commit metadata exists to cycle. */
  cycleCommitDetailsMode?: () => void;
  toggleFocusArea: () => void;
  toggleHelp: () => void;
  toggleHunkHeaders: () => void;
  toggleLineNumbers: () => void;
  toggleLineWrap: () => void;
  toggleSidebar: () => void;
  triggerRefreshCurrentInput: () => void;
}

/** Register the app's scoped keyboard handling while keeping mode precedence explicit. */
export function useAppKeyboardShortcuts({
  activeMenuId,
  activateCurrentMenuItem,
  canRefreshCurrentInput,
  closeHelp,
  closeMenu,
  cycleTheme,
  focusArea,
  focusFilter,
  moveToAnnotatedHunk,
  moveToHunk,
  moveMenuItem,
  openMenu,
  pagerMode,
  requestMoveCommit,
  pendingCommitConfirmation,
  onConfirmCommitMove,
  onCancelCommitMove,
  requestQuit,
  scrollCodeHorizontally,
  scrollDiff,
  selectLayoutMode,
  showHelp,
  switchMenu,
  toggleAgentNotes,
  cycleCommitDetailsMode,
  toggleFocusArea,
  toggleHelp,
  toggleHunkHeaders,
  toggleLineNumbers,
  toggleLineWrap,
  toggleSidebar,
  triggerRefreshCurrentInput,
}: UseAppKeyboardShortcutsOptions) {
  const activeMenuIdRef = useRef(activeMenuId);
  const focusAreaRef = useRef(focusArea);
  const pagerModeRef = useRef(pagerMode);
  const showHelpRef = useRef(showHelp);
  const pendingCommitConfirmationRef = useRef(Boolean(pendingCommitConfirmation));

  activeMenuIdRef.current = activeMenuId;
  focusAreaRef.current = focusArea;
  pagerModeRef.current = pagerMode;
  showHelpRef.current = showHelp;
  pendingCommitConfirmationRef.current = Boolean(pendingCommitConfirmation);

  const runAndCloseMenu = (action: () => void) => {
    action();
    closeMenu();
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

  const handlePagerShortcut = (key: KeyEvent) => {
    if (key.name === "q" || isEscapeKey(key)) {
      requestQuit();
      return;
    }

    if (isPageDownKey(key)) {
      scrollDiff(1, "viewport");
      return;
    }

    if (isPageUpKey(key) || isShiftSpacePageUpKey(key)) {
      scrollDiff(-1, "viewport");
      return;
    }

    if (isHalfPageDownKey(key)) {
      scrollDiff(1, "half");
      return;
    }

    if (isHalfPageUpKey(key)) {
      scrollDiff(-1, "half");
      return;
    }

    if (isStepDownKey(key)) {
      scrollDiff(1, "step");
      return;
    }

    if (isStepUpKey(key)) {
      scrollDiff(-1, "step");
      return;
    }

    if (key.name === "left") {
      scrollCodeHorizontally(key.shift ? -FAST_CODE_HORIZONTAL_SCROLL_COLUMNS : -1);
      return;
    }

    if (key.name === "right") {
      scrollCodeHorizontally(key.shift ? FAST_CODE_HORIZONTAL_SCROLL_COLUMNS : 1);
      return;
    }

    if (key.name === "home") {
      scrollDiff(-1, "content");
      return;
    }

    if (key.name === "end") {
      scrollDiff(1, "content");
      return;
    }

    if (key.name === "w" || key.sequence === "w") {
      toggleLineWrap();
      return;
    }

    if (key.name === "s" || key.sequence === "s") {
      toggleSidebar();
    }
  };

  const handleHelpShortcut = (key: KeyEvent) => {
    if (!showHelpRef.current || !isEscapeKey(key)) {
      return false;
    }

    closeHelp();
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

  const handleFilterShortcut = (key: KeyEvent) => {
    if (focusAreaRef.current !== "filter") {
      return false;
    }

    if (key.name === "tab") {
      toggleFocusArea();
      return true;
    }

    // Let the focused input own filter editing and escape handling.
    return true;
  };

  const handleAppShortcut = (key: KeyEvent) => {
    if (key.name === "q") {
      requestQuit();
      return;
    }

    if (key.name === "?" || key.sequence === "?") {
      toggleHelp();
      closeMenu();
      return;
    }

    if (isEscapeKey(key)) {
      requestQuit();
      return;
    }

    if (key.name === "tab") {
      toggleFocusArea();
      return;
    }

    if (key.name === "/") {
      focusFilter();
      return;
    }

    if (isPageDownKey(key)) {
      scrollDiff(1, "viewport");
      return;
    }

    if (isPageUpKey(key) || isShiftSpacePageUpKey(key)) {
      scrollDiff(-1, "viewport");
      return;
    }

    if (isHalfPageDownKey(key)) {
      scrollDiff(1, "half");
      return;
    }

    if (isHalfPageUpKey(key)) {
      scrollDiff(-1, "half");
      return;
    }

    if (key.name === "home") {
      scrollDiff(-1, "content");
      return;
    }

    if (key.name === "end") {
      scrollDiff(1, "content");
      return;
    }

    if (isStepUpKey(key)) {
      scrollDiff(-1, "step");
      return;
    }

    if (isStepDownKey(key)) {
      scrollDiff(1, "step");
      return;
    }

    if (key.name === "left") {
      scrollCodeHorizontally(key.shift ? -FAST_CODE_HORIZONTAL_SCROLL_COLUMNS : -1);
      return;
    }

    if (key.name === "right") {
      scrollCodeHorizontally(key.shift ? FAST_CODE_HORIZONTAL_SCROLL_COLUMNS : 1);
      return;
    }

    if (key.name === "1") {
      runAndCloseMenu(() => selectLayoutMode("split"));
      return;
    }

    if (key.name === "2") {
      runAndCloseMenu(() => selectLayoutMode("stack"));
      return;
    }

    if (key.name === "0") {
      runAndCloseMenu(() => selectLayoutMode("auto"));
      return;
    }

    if (key.name === "s") {
      runAndCloseMenu(toggleSidebar);
      return;
    }

    if ((key.name === "r" || key.sequence === "r") && canRefreshCurrentInput) {
      runAndCloseMenu(triggerRefreshCurrentInput);
      return;
    }

    if (key.name === "t") {
      runAndCloseMenu(cycleTheme);
      return;
    }

    if (key.name === "a") {
      runAndCloseMenu(toggleAgentNotes);
      return;
    }

    if (key.name === "l" || key.sequence === "l") {
      runAndCloseMenu(toggleLineNumbers);
      return;
    }

    if (key.name === "w" || key.sequence === "w") {
      runAndCloseMenu(toggleLineWrap);
      return;
    }

    if (key.name === "m" || key.sequence === "m") {
      runAndCloseMenu(toggleHunkHeaders);
      return;
    }

    if (cycleCommitDetailsMode && (key.name === "c" || key.sequence === "c")) {
      runAndCloseMenu(cycleCommitDetailsMode);
      return;
    }

    if (key.name === "[") {
      runAndCloseMenu(() => moveToHunk(-1));
      return;
    }

    if (key.name === "]") {
      runAndCloseMenu(() => moveToHunk(1));
      return;
    }

    if (key.sequence === "{") {
      runAndCloseMenu(() => moveToAnnotatedHunk(-1));
      return;
    }

    if (key.sequence === "}") {
      runAndCloseMenu(() => moveToAnnotatedHunk(1));
    }
  };

  useKeyboard((key: KeyEvent) => {
    if (handleMenuToggleShortcut(key)) {
      return;
    }

    // Commit-move confirmation has the highest precedence: while a confirmation is
    // pending, swallow every other key so user input can't accidentally fire scroll /
    // selection / filter actions. Only y/Y, n/N, and Esc do anything.
    if (pendingCommitConfirmationRef.current) {
      const sequence = key.sequence?.toLowerCase();
      if (key.name === "y" || sequence === "y") {
        onConfirmCommitMove?.();
      } else if (
        isEscapeKey(key) ||
        key.name === "n" ||
        sequence === "n" ||
        key.name === "return" ||
        key.name === "enter"
      ) {
        // Treat Enter as "no" so a fat-finger can't bypass the prompt by reflex.
        onCancelCommitMove?.();
      }
      return;
    }

    // Commit cursor navigation works in every mode that has a cursor: pager-bare
    // streaming, pager commit-review, and (in principle) any future review mode that
    // exposes commit cursors. Bound at the top so it's not buried inside either of
    // the per-mode handlers below.
    if (requestMoveCommit && (key.name === ">" || key.sequence === ">")) {
      requestMoveCommit(1);
      return;
    }
    if (requestMoveCommit && (key.name === "<" || key.sequence === "<")) {
      requestMoveCommit(-1);
      return;
    }

    if (pagerModeRef.current) {
      handlePagerShortcut(key);
      return;
    }

    if (handleHelpShortcut(key)) {
      return;
    }

    if (handleMenuShortcut(key)) {
      return;
    }

    if (handleFilterShortcut(key)) {
      return;
    }

    handleAppShortcut(key);
  });
}

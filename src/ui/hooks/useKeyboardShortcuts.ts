import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { LayoutMode } from "../../core/types";
import type { MenuId } from "../components/chrome/menu";

export type FocusArea = "files" | "filter";

export interface UseKeyboardShortcutsOptions {
  activeMenuId: MenuId | null;
  canRefreshCurrentInput: boolean;
  filter: string;
  focusArea: FocusArea;
  pagerMode: boolean;
  showHelp: boolean;
  onActivateMenuItem: () => void;
  onCloseMenu: () => void;
  onMoveAnnotatedHunk: (delta: number) => void;
  onMoveHunk: (delta: number) => void;
  onMoveMenuItem: (delta: number) => void;
  onOpenMenu: (menuId: MenuId) => void;
  onQuit: () => void;
  onRefreshCurrentInput: () => void;
  onScrollDiff: (delta: number, unit: "step" | "viewport" | "content" | "half") => void;
  onSetFilter: (value: string) => void;
  onSetFocusArea: (area: FocusArea) => void;
  onSetLayoutMode: (mode: LayoutMode) => void;
  onSwitchMenu: (delta: number) => void;
  onToggleAgentNotes: () => void;
  onToggleFocusArea: () => void;
  onToggleHelp: () => void;
  onToggleHunkHeaders: () => void;
  onToggleLineNumbers: () => void;
  onToggleLineWrap: () => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
}

/** Register the shell's global keyboard shortcuts. */
export function useKeyboardShortcuts({
  activeMenuId,
  canRefreshCurrentInput,
  filter,
  focusArea,
  pagerMode,
  showHelp,
  onActivateMenuItem,
  onCloseMenu,
  onMoveAnnotatedHunk,
  onMoveHunk,
  onMoveMenuItem,
  onOpenMenu,
  onQuit,
  onRefreshCurrentInput,
  onScrollDiff,
  onSetFilter,
  onSetFocusArea,
  onSetLayoutMode,
  onSwitchMenu,
  onToggleAgentNotes,
  onToggleFocusArea,
  onToggleHelp,
  onToggleHunkHeaders,
  onToggleLineNumbers,
  onToggleLineWrap,
  onToggleSidebar,
  onToggleTheme,
}: UseKeyboardShortcutsOptions) {
  useKeyboard((key: KeyEvent) => {
    const pageDownKey =
      key.name === "pagedown" ||
      key.name === "space" ||
      key.name === " " ||
      key.sequence === " " ||
      key.name === "f" ||
      key.sequence === "f";
    const pageUpKey = key.name === "pageup" || key.name === "b" || key.sequence === "b";
    const stepDownKey = key.name === "down" || key.name === "j" || key.sequence === "j";
    const stepUpKey = key.name === "up" || key.name === "k" || key.sequence === "k";
    const halfPageDownKey = key.name === "d" || key.sequence === "d";
    const halfPageUpKey = key.name === "u" || key.sequence === "u";
    const shiftSpacePageUpKey =
      key.shift && (key.name === "space" || key.name === " " || key.sequence === " ");

    if (key.name === "f10") {
      if (!pagerMode) {
        if (activeMenuId) {
          onCloseMenu();
        } else {
          onOpenMenu("file");
        }
      }
      return;
    }

    if (pagerMode) {
      if (key.name === "q" || key.name === "escape") {
        onQuit();
        return;
      }
      if (pageDownKey) return onScrollDiff(1, "viewport");
      if (pageUpKey || shiftSpacePageUpKey) return onScrollDiff(-1, "viewport");
      if (halfPageDownKey) return onScrollDiff(1, "half");
      if (halfPageUpKey) return onScrollDiff(-1, "half");
      if (stepDownKey) return onScrollDiff(1, "step");
      if (stepUpKey) return onScrollDiff(-1, "step");
      if (key.name === "home") return onScrollDiff(-1, "content");
      if (key.name === "end") return onScrollDiff(1, "content");
      if (key.name === "w" || key.sequence === "w") onToggleLineWrap();
      return;
    }

    if (showHelp && key.name === "escape") {
      onToggleHelp();
      return;
    }

    if (activeMenuId) {
      if (key.name === "escape") return onCloseMenu();
      if (key.name === "left") return onSwitchMenu(-1);
      if (key.name === "right" || key.name === "tab") return onSwitchMenu(1);
      if (key.name === "up") return onMoveMenuItem(-1);
      if (key.name === "down") return onMoveMenuItem(1);
      if (key.name === "return" || key.name === "enter") return onActivateMenuItem();
    }

    if (focusArea === "filter") {
      if (key.name === "escape") {
        if (filter.length > 0) {
          onSetFilter("");
          return;
        }

        onSetFocusArea("files");
        return;
      }

      if (key.name === "tab") {
        onToggleFocusArea();
      }
      return;
    }

    if (key.name === "q" || key.name === "escape") return onQuit();
    if (key.name === "?") {
      onToggleHelp();
      onCloseMenu();
      return;
    }
    if (key.name === "tab") return onToggleFocusArea();
    if (key.name === "/") return onSetFocusArea("filter");
    if (pageDownKey) return onScrollDiff(1, "viewport");
    if (pageUpKey || shiftSpacePageUpKey) return onScrollDiff(-1, "viewport");
    if (halfPageDownKey) return onScrollDiff(1, "half");
    if (halfPageUpKey) return onScrollDiff(-1, "half");
    if (key.name === "home") return onScrollDiff(-1, "content");
    if (key.name === "end") return onScrollDiff(1, "content");
    if (key.name === "up") return onScrollDiff(-1, "step");
    if (key.name === "down") return onScrollDiff(1, "step");

    if (key.name === "1") {
      onSetLayoutMode("split");
      onCloseMenu();
      return;
    }
    if (key.name === "2") {
      onSetLayoutMode("stack");
      onCloseMenu();
      return;
    }
    if (key.name === "0") {
      onSetLayoutMode("auto");
      onCloseMenu();
      return;
    }
    if (key.name === "s") {
      onToggleSidebar();
      onCloseMenu();
      return;
    }
    if ((key.name === "r" || key.sequence === "r") && canRefreshCurrentInput) {
      onRefreshCurrentInput();
      onCloseMenu();
      return;
    }
    if (key.name === "t") {
      onToggleTheme();
      onCloseMenu();
      return;
    }
    if (key.name === "a") {
      onToggleAgentNotes();
      onCloseMenu();
      return;
    }
    if (key.name === "l" || key.sequence === "l") {
      onToggleLineNumbers();
      onCloseMenu();
      return;
    }
    if (key.name === "w" || key.sequence === "w") {
      onToggleLineWrap();
      onCloseMenu();
      return;
    }
    if (key.name === "m" || key.sequence === "m") {
      onToggleHunkHeaders();
      onCloseMenu();
      return;
    }
    if (key.name === "[") {
      onMoveHunk(-1);
      onCloseMenu();
      return;
    }
    if (key.name === "]") {
      onMoveHunk(1);
      onCloseMenu();
      return;
    }
    if (key.sequence === "{") {
      onMoveAnnotatedHunk(-1);
      onCloseMenu();
      return;
    }
    if (key.sequence === "}") {
      onMoveAnnotatedHunk(1);
      onCloseMenu();
    }
  });
}

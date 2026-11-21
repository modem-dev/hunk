/** @jsxImportSource react */
/**
 * The theme picker's list: a listbox of the built-in themes, opened from the View menu's
 * Theme row or with `t` (the terminal's `hunk.view.openThemeSelector`).
 *
 * A real listbox rather than a native `<select>`, so it can wear the theme's own colors.
 * Keyboard behaves like a select: the arrow keys, Home, and End move the active option, typing
 * a letter jumps to the next theme starting with it, Enter or Space chooses, and Escape or Tab
 * closes. Opening starts at the current theme; closing hands focus back through `onClose`,
 * which the View menu points at its own button. When the session resolved a theme, the first
 * option follows it ("Use session theme") and choosing it clears this browser's override.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { WebTheme } from "../theme/themeIndex";

/** One choice in the menu. */
export type ThemeMenuOption = Pick<WebTheme, "id" | "label" | "appearance">;

export interface ThemeMenuProps {
  themes: readonly ThemeMenuOption[];
  /** The option shown as chosen. */
  themeId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTheme: (themeId: string) => void;
  /** The region a click inside does not count as "outside" (the menu's anchor). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Returns focus to the control that owns the list once it closes from the keyboard. */
  onClose: () => void;
}

/** The theme picker's listbox, shown while `open`. */
export function ThemeMenu({
  themes,
  themeId,
  open,
  onOpenChange,
  onTheme,
  anchorRef,
  onClose,
}: ThemeMenuProps) {
  const listId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  const currentIndex = Math.max(
    0,
    themes.findIndex((theme) => theme.id === themeId),
  );
  const [active, setActive] = useState(currentIndex);

  // Opening starts at the current theme and moves focus into the list.
  useEffect(() => {
    if (!open) return;
    setActive(currentIndex);
    listRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the active option in view as it moves.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // A click anywhere else closes the list without choosing.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, onOpenChange, anchorRef]);

  const close = () => {
    onOpenChange(false);
    onClose();
  };

  const choose = (index: number) => {
    const theme = themes[index];
    if (theme) onTheme(theme.id);
    close();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const last = themes.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(last, active + 1),
      ArrowUp: () => Math.max(0, active - 1),
      Home: () => 0,
      End: () => last,
      PageDown: () => Math.min(last, active + 10),
      PageUp: () => Math.max(0, active - 10),
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      setActive(move());
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      close();
      return;
    }
    if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey) {
      // Type-ahead: the next theme after the active one whose name starts with the letter.
      // The open menu consumes every letter, matched or not, so none reaches page shortcuts.
      event.preventDefault();
      const letter = event.key.toLowerCase();
      const ordered = [...themes.slice(active + 1), ...themes.slice(0, active + 1)];
      const match = ordered.find((theme) => theme.label.toLowerCase().startsWith(letter));
      if (match) setActive(themes.indexOf(match));
    }
  };

  if (!open) return null;

  return (
    <ul
      ref={listRef}
      id={listId}
      className="menu theme-menu"
      role="listbox"
      aria-label="Themes"
      // In the tab order while open (Tab itself closes it), which also makes the
      // scrolling list reachable without a pointer.
      tabIndex={0}
      aria-activedescendant={`${listId}-${active}`}
      onKeyDown={onListKeyDown}
    >
      {themes.map((theme, index) => (
        <li
          key={theme.id}
          id={`${listId}-${index}`}
          role="option"
          data-index={index}
          data-theme-id={theme.id}
          aria-selected={theme.id === themeId}
          data-active={index === active ? "" : undefined}
          onPointerEnter={() => setActive(index)}
          onClick={() => choose(index)}
        >
          <span className="theme-appearance" data-appearance={theme.appearance}>
            {theme.appearance === "light" ? "☀" : "☾"}
          </span>
          {theme.label}
        </li>
      ))}
    </ul>
  );
}

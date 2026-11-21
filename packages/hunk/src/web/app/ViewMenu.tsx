/** @jsxImportSource react */
/**
 * Shows the toolbar's View menu: the display toggles that do not earn a toolbar button of
 * their own, plus the theme picker.
 *
 * Rows: Wrap long lines, Line numbers (this browser's view preferences), Agent notes (shared
 * with every surface through the `hunk.view.toggleAgentNotes` command path, and labelled as
 * shared), Hide viewed files (this browser only), and Theme, which opens the theme listbox
 * (`ThemeMenu`) in place of the menu. Each row names its shortcut from the page's keymap, so a
 * remap shows up here too; the shortcuts work with the menu closed.
 *
 * Menu semantics follow `ThemeMenu`: opening moves focus to the first row, the arrow keys,
 * Home, and End move between rows, Escape closes and returns focus to the View button, Tab
 * and a click elsewhere close it. Toggling a row keeps the menu open so several can change at
 * once. The menu stays mounted while closed (`hidden`), so the rows' state stays queryable.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "../icons/Icon";
import { ThemeMenu, type ThemeMenuOption } from "./ThemeMenu";

export interface ViewMenuProps {
  wrapLines: boolean;
  showLineNumbers: boolean;
  onPreferences: (next: { wrapLines?: boolean; showLineNumbers?: boolean }) => void;
  agentNotesVisible: boolean;
  onToggleAgentNotes: () => void;
  hideViewed: boolean;
  onToggleHideViewed: () => void;
  /** The session has ended: shared toggles need it, so they are disabled. */
  sessionEnded?: boolean;
  themes: readonly ThemeMenuOption[];
  /** The theme option shown as chosen. */
  themeId: string | undefined;
  /** The theme in effect, named on the Theme row. */
  themeLabel?: string;
  themeMenuOpen: boolean;
  onThemeMenuOpen: (open: boolean) => void;
  onTheme: (themeId: string) => void;
  /** Shortcut labels for the rows that have one on this page. */
  hints: {
    wrap: string | undefined;
    lineNumbers: string | undefined;
    agentNotes: string | undefined;
    hideViewed: string | undefined;
    theme: string | undefined;
  };
}

/** The selector for every row the arrow keys move between. */
const ROW_SELECTOR = '[role="menuitemcheckbox"]:not(:disabled), [role="menuitem"]:not(:disabled)';

interface ToggleRowProps {
  label: string;
  /** Extra words for assistive technology only, appended to the visible label. */
  spokenSuffix?: string;
  /** A short visible note beside the label ("shared"). */
  note?: string;
  checked: boolean;
  hint?: string;
  title: string;
  disabled?: boolean;
  testId?: string;
  onToggle: () => void;
}

/** One checkable menu row with its shortcut and an on/off switch. */
function ToggleRow(props: ToggleRowProps) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      className="menu-row"
      aria-checked={props.checked}
      tabIndex={-1}
      title={props.hint ? `${props.title} (${props.hint})` : props.title}
      disabled={props.disabled}
      data-testid={props.testId}
      onClick={props.onToggle}
    >
      <span className="menu-row-label">
        {props.label}
        {props.spokenSuffix ? <span className="visually-hidden">{props.spokenSuffix}</span> : null}
        {props.note ? (
          <span className="shared-hint menu-row-note" aria-hidden="true">
            {props.note}
          </span>
        ) : null}
      </span>
      {props.hint ? (
        <kbd className="key-hint" aria-hidden="true">
          {props.hint}
        </kbd>
      ) : null}
      <span className="menu-switch" aria-hidden="true" />
    </button>
  );
}

/** A labelled group of rows. */
function RowGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <div className="menu-heading" id={id} aria-hidden="true">
        {label}
      </div>
      {children}
    </div>
  );
}

/** The toolbar's View button and menu. */
export function ViewMenu(props: ViewMenuProps) {
  const { themeMenuOpen, onThemeMenuOpen } = props;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const themeLabel =
    props.themeLabel ?? props.themes.find((theme) => theme.id === props.themeId)?.label;

  const rows = (): HTMLElement[] =>
    menuRef.current ? Array.from(menuRef.current.querySelectorAll<HTMLElement>(ROW_SELECTOR)) : [];

  // Opening moves focus to the first row.
  useEffect(() => {
    if (open) rows()[0]?.focus();
  }, [open]);

  // The theme list replaces the menu, whichever way it opened (`t` or the Theme row).
  useEffect(() => {
    if (themeMenuOpen) setOpen(false);
  }, [themeMenuOpen]);

  // A click anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const focusButton = useCallback(() => buttonRef.current?.focus(), []);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = rows();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const last = items.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => (index >= last ? 0 : index + 1),
      ArrowUp: () => (index <= 0 ? last : index - 1),
      Home: () => 0,
      End: () => last,
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      items[move()]?.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      focusButton();
      return;
    }
    if (event.key === "Tab") setOpen(false);
  };

  return (
    <div className="menu-anchor" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="tool-button toolbar-pill view-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title="View options: wrapping, line numbers, agent notes, viewed files, theme"
        data-testid="view-menu-button"
        onClick={() => {
          onThemeMenuOpen(false);
          setOpen(!open);
        }}
      >
        <Icon name="sliders" />
        <span className="pill-label">View</span>
        <Icon name="chevron-down" size={12} className="pill-chevron" />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-label="View"
        className="menu view-menu"
        hidden={!open}
        onKeyDown={onMenuKeyDown}
      >
        <RowGroup label="Lines">
          <ToggleRow
            label="Wrap long lines"
            title="Wrap long lines"
            checked={props.wrapLines}
            {...(props.hints.wrap ? { hint: props.hints.wrap } : {})}
            testId="toggle-wrap"
            onToggle={() => props.onPreferences({ wrapLines: !props.wrapLines })}
          />
          <ToggleRow
            label="Line numbers"
            title="Show line numbers"
            checked={props.showLineNumbers}
            {...(props.hints.lineNumbers ? { hint: props.hints.lineNumbers } : {})}
            testId="toggle-line-numbers"
            onToggle={() => props.onPreferences({ showLineNumbers: !props.showLineNumbers })}
          />
        </RowGroup>
        <div role="separator" className="menu-separator" />
        <RowGroup label="Review">
          <ToggleRow
            label="Agent notes"
            spokenSuffix=", shared with the terminal"
            note="shared"
            title="Show agent notes; shared with the terminal and every other window on this review"
            checked={props.agentNotesVisible}
            {...(props.hints.agentNotes ? { hint: props.hints.agentNotes } : {})}
            {...(props.sessionEnded ? { disabled: true } : {})}
            testId="toggle-agent-notes"
            onToggle={props.onToggleAgentNotes}
          />
          <ToggleRow
            label="Hide viewed files"
            title="Hide viewed files in this browser; the marks stay shared"
            checked={props.hideViewed}
            {...(props.hints.hideViewed ? { hint: props.hints.hideViewed } : {})}
            testId="toggle-hide-viewed"
            onToggle={props.onToggleHideViewed}
          />
        </RowGroup>
        <div role="separator" className="menu-separator" />
        <button
          type="button"
          role="menuitem"
          className="menu-row theme-button"
          tabIndex={-1}
          aria-haspopup="listbox"
          aria-expanded={themeMenuOpen}
          title={props.hints.theme ? `Choose theme (${props.hints.theme})` : "Choose theme"}
          data-testid="theme-picker"
          data-theme-id={props.themeId}
          disabled={props.themes.length === 0}
          onClick={() => onThemeMenuOpen(true)}
        >
          <span className="theme-swatch" aria-hidden="true" />
          {/* Named by its content ("Theme: <name>"), so the visible shortcut stays out of it. */}
          <span className="menu-row-label theme-label">
            <span className="visually-hidden">Theme: </span>
            {themeLabel ?? <span aria-hidden="true">Theme</span>}
            {themeLabel ? null : <span className="visually-hidden">loading</span>}
          </span>
          {props.hints.theme ? (
            <kbd className="key-hint" aria-hidden="true">
              {props.hints.theme}
            </kbd>
          ) : null}
          <Icon name="chevron-right" size={12} className="pill-chevron" />
        </button>
      </div>
      <ThemeMenu
        themes={props.themes}
        themeId={props.themeId}
        open={themeMenuOpen}
        onOpenChange={onThemeMenuOpen}
        onTheme={props.onTheme}
        anchorRef={rootRef}
        onClose={focusButton}
      />
    </div>
  );
}

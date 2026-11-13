/** @jsxImportSource react */
/**
 * The page's toolbar: what the terminal's menu bar title says, plus web-native view controls.
 *
 * The left side mirrors the terminal's `topTitle` — review title, file count, and total
 * `+A -D` — with connection and load state beside it. The right side holds the per-browser
 * view controls: sidebar, layout (auto, split, unified), wrapping, line numbers, and theme.
 * They are real buttons, styled from the theme's tokens, and each names the shortcut that
 * does the same thing (from the page's keymap, so a remap shows up here too). None of them
 * reaches the session.
 */
import type { KeyboardEvent, ReactNode } from "react";
import type { LayoutMode } from "../../core/run/commandInputs";
import type { WebImplementedCommandId } from "../commands/webCommandTable";

import type { WebViewPreferences } from "../view/viewPreferences";
import { ThemeMenu, type ThemeMenuOption } from "./ThemeMenu";

export interface ToolbarProps {
  title: string;
  fileCount: number;
  additions: number;
  deletions: number;
  status: { label: string; state: "connected" | "loading" | "reconnecting" | "failed" };
  progress?: string;
  preferences: WebViewPreferences;
  sidebarOpen: boolean;
  resolvedLayout: "split" | "unified";
  themes: readonly ThemeMenuOption[];
  /** The theme option shown as chosen. */
  themeId: string | undefined;
  /** The theme in effect. */
  themeLabel?: string;
  /** The session's source, shown beside the title. */
  sourceLabel?: string;
  /** The shared file filter, when the session has one. */
  filter?: string;
  /** Sidecar notes the session left out of the shared state; the terminal still shows them. */
  omittedNotes?: number;
  themeMenuOpen: boolean;
  onThemeMenuOpen: (open: boolean) => void;
  onPreferences: (next: Partial<WebViewPreferences>) => void;
  onToggleSidebar: () => void;
  onTheme: (themeId: string) => void;
  /** Review controls shown before the view controls (filter, refresh, copy link). */
  controls?: ReactNode;
  /** The shortcut label for one command, when it has one on this page. */
  keyHint: (commandId: WebImplementedCommandId) => string | undefined;
}

const LAYOUTS: readonly { mode: LayoutMode; command: WebImplementedCommandId }[] = [
  { mode: "auto", command: "hunk.view.layoutAuto" },
  { mode: "split", command: "hunk.view.layoutSplit" },
  { mode: "unified", command: "hunk.view.layoutUnified" },
];

/** A tooltip naming one action and, when bound, its shortcut. */
function hinted(label: string, hint: string | undefined) {
  return hint ? `${label} (${hint})` : label;
}

/** The page toolbar. */
export function Toolbar(props: ToolbarProps) {
  const { preferences, keyHint } = props;

  // Arrow keys move the choice within the layout group, as in any radio group.
  const onLayoutKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = LAYOUTS.findIndex((layout) => layout.mode === preferences.layout);
    const next = LAYOUTS[(index + step + LAYOUTS.length) % LAYOUTS.length]!;
    props.onPreferences({ layout: next.mode });
    event.currentTarget.querySelector<HTMLElement>(`[data-testid="layout-${next.mode}"]`)?.focus();
  };

  return (
    <header className="toolbar" role="banner">
      <button
        type="button"
        className="tool-button icon-button"
        aria-pressed={props.sidebarOpen}
        aria-label={props.sidebarOpen ? "Hide files sidebar" : "Show files sidebar"}
        title={hinted(
          props.sidebarOpen ? "Hide files" : "Show files",
          keyHint("hunk.view.toggleFilesPane"),
        )}
        onClick={props.onToggleSidebar}
        data-testid="toggle-sidebar"
      >
        <span aria-hidden="true">☰</span>
      </button>
      <div className="toolbar-title">
        <span className="review-title" title={props.sourceLabel}>
          {props.title}
        </span>
        <span className="file-count" data-testid="file-count">
          {props.fileCount === 1 ? "1 file" : `${props.fileCount} files`}
        </span>
        <span className="stat-added">{`+${props.additions}`}</span>
        <span className="stat-removed">{`-${props.deletions}`}</span>
        {props.filter ? (
          <span className="filter-chip" data-testid="shared-filter" title="Filter from the session">
            {`filter: ${props.filter}`}
          </span>
        ) : null}
        {props.omittedNotes ? (
          <span
            className="filter-chip"
            data-testid="omitted-notes"
            title="The session's agent-context file has more notes than a browser is sent; the terminal shows them all."
          >
            {`${props.omittedNotes} agent ${props.omittedNotes === 1 ? "note" : "notes"} not shown`}
          </span>
        ) : null}
        <span className="status" data-state={props.status.state} role="status">
          {props.status.label}
        </span>
        {props.progress ? (
          <span className="progress" data-testid="load-progress">
            {props.progress}
          </span>
        ) : null}
      </div>
      <div className="toolbar-controls">
        {props.controls}
        <div
          className="segmented"
          role="radiogroup"
          aria-label="Layout"
          onKeyDown={onLayoutKeyDown}
        >
          {LAYOUTS.map(({ mode, command }) => {
            const checked = preferences.layout === mode;
            const label = mode[0]!.toUpperCase() + mode.slice(1);
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                data-testid={`layout-${mode}`}
                title={hinted(
                  mode === "auto"
                    ? `Auto layout, ${props.resolvedLayout} at this width`
                    : `${label} layout`,
                  keyHint(command),
                )}
                onClick={() => props.onPreferences({ layout: mode })}
              >
                {label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="tool-button toggle-button"
          aria-pressed={preferences.wrapLines}
          title={hinted("Wrap long lines", keyHint("hunk.view.toggleLineWrap"))}
          data-testid="toggle-wrap"
          onClick={() => props.onPreferences({ wrapLines: !preferences.wrapLines })}
        >
          Wrap
        </button>
        <button
          type="button"
          className="tool-button toggle-button"
          aria-pressed={preferences.showLineNumbers}
          title={hinted("Show line numbers", keyHint("hunk.view.toggleLineNumbers"))}
          data-testid="toggle-line-numbers"
          onClick={() => props.onPreferences({ showLineNumbers: !preferences.showLineNumbers })}
        >
          Line numbers
        </button>
        <ThemeMenu
          themes={props.themes}
          themeId={props.themeId}
          {...(props.themeLabel !== undefined ? { currentLabel: props.themeLabel } : {})}
          open={props.themeMenuOpen}
          onOpenChange={props.onThemeMenuOpen}
          onTheme={props.onTheme}
          keyHint={keyHint("hunk.view.openThemeSelector")}
        />
      </div>
    </header>
  );
}

/** @jsxImportSource react */
/**
 * Lays out the page's toolbar as one row: what the terminal's menu bar title says on the left,
 * web-native view controls on the right.
 *
 * The left side mirrors the terminal's `topTitle` — review title, file count, and total
 * `+A -D` — with connection and load state beside it (a quiet dot while connected, words while
 * loading, reconnecting, or failed). The right side holds the shared filter, viewed progress,
 * layout (auto, split, unified), the View menu, refresh, copy link, the command palette, and
 * the side panel. Controls are icon buttons where the icon says enough; each names its action
 * and the shortcut that does the same thing (from the page's keymap, so a remap shows up here
 * too) in its tooltip. Narrow windows drop labels before controls (`styles.css`) so the row
 * never wraps. None of the view controls reaches the session.
 */
import type { KeyboardEvent, ReactNode } from "react";
import type { LayoutMode } from "../../core/run/commandInputs";
import type { WebImplementedCommandId } from "../commands/webCommandTable";
import { Icon, type IconName } from "../icons/Icon";

export interface ToolbarProps {
  title: string;
  fileCount: number;
  additions: number;
  deletions: number;
  status: { label: string; state: "connected" | "loading" | "reconnecting" | "failed" };
  progress?: string;
  layout: LayoutMode;
  onLayout: (layout: LayoutMode) => void;
  sidebarOpen: boolean;
  resolvedLayout: "split" | "unified";
  /** The session's source, shown beside the title. */
  sourceLabel?: string;
  /** The shared file filter, when the session has one. */
  filter?: string;
  /** Sidecar notes the session left out of the shared state; the terminal still shows them. */
  omittedNotes?: number;
  onToggleSidebar: () => void;
  /** The filter field. */
  filterField?: ReactNode;
  /** Viewed progress. */
  viewedProgress?: ReactNode;
  /** The View menu. */
  viewMenu?: ReactNode;
  /** Refresh and copy link. */
  reviewActions?: ReactNode;
  /** Opens the command palette, and the chord that does the same. */
  onOpenCommands?: () => void;
  commandsHint?: string;
  /** The shortcut label for one command, when it has one on this page. */
  keyHint: (commandId: WebImplementedCommandId) => string | undefined;
  /** Whether the side panel of review tools is open, and how to toggle it. */
  panelOpen?: boolean;
  panelHint?: string;
  onTogglePanel?: () => void;
}

const LAYOUTS: readonly { mode: LayoutMode; command: WebImplementedCommandId; icon: IconName }[] = [
  { mode: "auto", command: "hunk.view.layoutAuto", icon: "layout-auto" },
  { mode: "split", command: "hunk.view.layoutSplit", icon: "layout-split" },
  { mode: "unified", command: "hunk.view.layoutUnified", icon: "layout-unified" },
];

/** A tooltip naming one action and, when bound, its shortcut. */
function hinted(label: string, hint: string | undefined) {
  return hint ? `${label} (${hint})` : label;
}

/** The page toolbar. */
export function Toolbar(props: ToolbarProps) {
  const { keyHint } = props;
  const connected = props.status.state === "connected";

  // Arrow keys move the choice within the layout group, as in any radio group.
  const onLayoutKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = LAYOUTS.findIndex((layout) => layout.mode === props.layout);
    const next = LAYOUTS[(index + step + LAYOUTS.length) % LAYOUTS.length]!;
    props.onLayout(next.mode);
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
        <Icon name="sidebar" />
      </button>
      <div className="toolbar-title">
        {/* The tooltip carries the whole title, which a narrow toolbar truncates. */}
        <span
          className="review-title"
          title={props.sourceLabel ? `${props.title} — ${props.sourceLabel}` : props.title}
        >
          {props.title}
        </span>
        <span className="toolbar-stats">
          <span className="file-count" data-testid="file-count">
            {props.fileCount === 1 ? "1 file" : `${props.fileCount} files`}
          </span>
          <span className="stat-added">{`+${props.additions}`}</span>
          <span className="stat-removed">{`-${props.deletions}`}</span>
        </span>
        {/* Connected is the quiet default: a dot whose words stay available to assistive
            technology. Every other state keeps its words on screen. */}
        <span
          className="status"
          data-state={props.status.state}
          role="status"
          title={connected ? props.status.label : undefined}
        >
          <span className={connected ? "visually-hidden" : undefined}>{props.status.label}</span>
        </span>
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
        {props.progress ? (
          <span className="progress" data-testid="load-progress">
            {props.progress}
          </span>
        ) : null}
      </div>
      <div className="toolbar-controls">
        {props.filterField}
        {props.viewedProgress}
        <span className="toolbar-separator" aria-hidden="true" />
        <div
          className="segmented icon-segmented"
          role="radiogroup"
          aria-label="Layout"
          onKeyDown={onLayoutKeyDown}
        >
          {LAYOUTS.map(({ mode, command, icon }) => {
            const checked = props.layout === mode;
            const label = `${mode[0]!.toUpperCase()}${mode.slice(1)}`;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={label}
                tabIndex={checked ? 0 : -1}
                data-testid={`layout-${mode}`}
                title={hinted(
                  mode === "auto"
                    ? `Auto layout, ${props.resolvedLayout} at this width`
                    : `${label} layout`,
                  keyHint(command),
                )}
                onClick={() => props.onLayout(mode)}
              >
                <Icon name={icon} />
              </button>
            );
          })}
        </div>
        {props.viewMenu}
        <span className="toolbar-separator" aria-hidden="true" />
        {props.reviewActions}
        {props.onOpenCommands ? (
          <button
            type="button"
            className="tool-button toolbar-pill commands-button"
            title={hinted("Command palette", props.commandsHint)}
            data-testid="open-command-palette"
            onClick={props.onOpenCommands}
          >
            <Icon name="search" />
            <span className="pill-label">Commands</span>
            {props.commandsHint ? (
              <kbd className="key-hint" aria-hidden="true">
                {props.commandsHint}
              </kbd>
            ) : null}
          </button>
        ) : null}
        {props.onTogglePanel ? (
          <button
            type="button"
            className="tool-button icon-button"
            aria-pressed={props.panelOpen ?? false}
            aria-label={props.panelOpen ? "Hide review tools" : "Show review tools"}
            title={hinted(
              props.panelOpen ? "Hide review tools" : "Show review tools",
              props.panelHint,
            )}
            data-testid="toggle-side-panel"
            onClick={props.onTogglePanel}
          >
            <Icon name="panel" />
          </button>
        ) : null}
      </div>
    </header>
  );
}

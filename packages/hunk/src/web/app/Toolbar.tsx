/** @jsxImportSource react */
/**
 * The page's toolbar: what the terminal's menu bar title says, plus web-native view controls.
 *
 * The left side mirrors the terminal's `topTitle` — review title, file count, and total
 * `+A -D` — with connection and load state beside it. The right side holds the per-browser
 * view controls: sidebar, layout (auto, split, unified), wrapping, line numbers, and theme.
 * None of them reaches the session.
 */
import type { LayoutMode } from "../../core/run/commandInputs";
import type { WebThemeV1 } from "../theme/themeIndex";
import type { WebViewPreferences } from "../view/viewPreferences";

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
  themes: readonly WebThemeV1[];
  themeId: string | undefined;
  onPreferences: (next: Partial<WebViewPreferences>) => void;
  onToggleSidebar: () => void;
  onTheme: (themeId: string) => void;
}

const LAYOUTS: readonly LayoutMode[] = ["auto", "split", "unified"];

/** The page toolbar. */
export function Toolbar(props: ToolbarProps) {
  const { preferences } = props;
  return (
    <header className="toolbar" role="banner">
      <button
        type="button"
        className="tool-button"
        aria-pressed={props.sidebarOpen}
        aria-label={props.sidebarOpen ? "Hide files sidebar" : "Show files sidebar"}
        title={props.sidebarOpen ? "Hide files" : "Show files"}
        onClick={props.onToggleSidebar}
        data-testid="toggle-sidebar"
      >
        ☰
      </button>
      <div className="toolbar-title">
        <span className="review-title">{props.title}</span>
        <span className="file-count" data-testid="file-count">
          {props.fileCount === 1 ? "1 file" : `${props.fileCount} files`}
        </span>
        <span className="stat-added">{`+${props.additions}`}</span>
        <span className="stat-removed">{`-${props.deletions}`}</span>
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
        <div className="segmented" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map((layout) => (
            <button
              key={layout}
              type="button"
              role="radio"
              aria-checked={preferences.layout === layout}
              data-testid={`layout-${layout}`}
              title={layout === "auto" ? `Auto (${props.resolvedLayout} at this width)` : undefined}
              onClick={() => props.onPreferences({ layout })}
            >
              {layout[0]!.toUpperCase() + layout.slice(1)}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={preferences.wrapLines}
            onChange={(event) => props.onPreferences({ wrapLines: event.target.checked })}
          />
          Wrap
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={preferences.showLineNumbers}
            onChange={(event) => props.onPreferences({ showLineNumbers: event.target.checked })}
          />
          Line numbers
        </label>
        <label className="theme-picker">
          <span className="visually-hidden">Theme</span>
          <select
            value={props.themeId ?? ""}
            onChange={(event) => props.onTheme(event.target.value)}
            data-testid="theme-picker"
            disabled={props.themes.length === 0}
          >
            {props.themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}

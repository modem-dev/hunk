/** @jsxImportSource react */
/**
 * The right-hand side panel: a docked, resizable, collapsible region of tabbed review tools.
 *
 * It owns only its frame — the tab strip, the close button, and the left-edge resizer — and
 * renders whichever tool the chosen tab names; each tool lives in its own module directory and
 * decides nothing about the panel. Open state, width, and tab are this browser's (see
 * `./panelPreferences.ts`). Tabs follow the ARIA tabs pattern: arrow keys move between them,
 * and the tool's region is a labelled tab panel.
 */
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { clampSidePanelWidth, type SidePanelTab } from "./panelPreferences";

export interface SidePanelTool {
  id: SidePanelTab;
  label: string;
  render: () => ReactNode;
}

export interface SidePanelProps {
  tools: readonly SidePanelTool[];
  tab: SidePanelTab;
  width: number;
  onTab: (tab: SidePanelTab) => void;
  /** Live width while dragging; `commit` is true once the drag ends. */
  onWidth: (width: number, commit: boolean) => void;
  onClose: () => void;
  closeHint?: string;
}

/** The docked side panel. */
export function SidePanel(props: SidePanelProps) {
  const active = props.tools.find((tool) => tool.id === props.tab) ?? props.tools[0]!;

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = props.tools.findIndex((tool) => tool.id === active.id);
    const next = props.tools[(index + step + props.tools.length) % props.tools.length]!;
    props.onTab(next.id);
    event.currentTarget.querySelector<HTMLElement>(`#side-panel-tab-${next.id}`)?.focus();
  };

  // Dragging the left edge widens the panel; the width is stored when the drag ends.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = props.width;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const widthAt = (clientX: number) => clampSidePanelWidth(startWidth - (clientX - startX));
    const move = (moveEvent: PointerEvent) => props.onWidth(widthAt(moveEvent.clientX), false);
    const end = (endEvent: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      props.onWidth(widthAt(endEvent.clientX), true);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  };

  return (
    <>
      <div
        className="side-panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side panel"
        aria-valuenow={props.width}
        onPointerDown={startResize}
      />
      <aside className="side-panel" aria-label="Review tools" data-testid="side-panel">
        <div className="side-panel-header">
          <div
            className="side-panel-tabs"
            role="tablist"
            aria-label="Review tools"
            onKeyDown={onTabKeyDown}
          >
            {props.tools.map((tool) => {
              const selected = tool.id === active.id;
              return (
                <button
                  key={tool.id}
                  id={`side-panel-tab-${tool.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`side-panel-${tool.id}`}
                  tabIndex={selected ? 0 : -1}
                  data-testid={`side-panel-tab-${tool.id}`}
                  onClick={() => props.onTab(tool.id)}
                >
                  {tool.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="side-panel-close"
            aria-label="Close side panel"
            title={props.closeHint ? `Close side panel (${props.closeHint})` : "Close side panel"}
            onClick={props.onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div
          className="side-panel-body"
          id={`side-panel-${active.id}`}
          role="tabpanel"
          aria-labelledby={`side-panel-tab-${active.id}`}
          tabIndex={0}
        >
          {active.render()}
        </div>
      </aside>
    </>
  );
}

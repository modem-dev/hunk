import type { ReactNode } from "react";
import type { ExtensionPaneProps, HunkExtensionAPI } from "hunkdiff/extension";

const LABEL = "─ Current line · old above, new below ";

/** Render a minimal current-line pane for the host's PTY contract tests. */
function TestCurrentLineLens({ currentLine, theme, width }: ExtensionPaneProps): ReactNode {
  if (!currentLine) return null;
  const label = LABEL.slice(0, Math.max(0, width));
  const rule = label + "─".repeat(Math.max(0, width - label.length));

  return (
    <box style={{ width, height: 3, flexDirection: "column", backgroundColor: theme.panel }}>
      <text fg={theme.border}>{rule}</text>
      {currentLine.render("old", width) as ReactNode}
      {currentLine.render("new", width) as ReactNode}
    </box>
  );
}

/** Register the test-owned pane through the public extension contract. */
export default function registerTestCurrentLineLens(hunk: HunkExtensionAPI) {
  hunk.registerPane({
    id: "current-line",
    title: "Current-line test fixture",
    placement: "bottom",
    height: { preferred: 3, min: 3, max: 3 },
    defaultOpen: true,
    currentLine: true,
    available: ({ currentLine }) => currentLine !== null,
    component: TestCurrentLineLens,
  });
}

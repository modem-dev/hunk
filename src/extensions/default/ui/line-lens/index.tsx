import type { ReactNode } from "react";
import type { ExtensionFactory, ExtensionPaneProps } from "../../../types";

const LENS_LABEL = "─ Current line · old above, new below ";

/** Build the lens rule from terminal-width ASCII without private UI helpers. */
function lineLensRule(width: number) {
  const label = LENS_LABEL.slice(0, Math.max(0, width));
  return label + "─".repeat(Math.max(0, width - label.length));
}

/** Render the selected split row's old/new sides in a fixed bottom pane. */
export function BuiltInLineLens({ currentLine, theme, width }: ExtensionPaneProps): ReactNode {
  if (!currentLine) return null;
  const rule = lineLensRule(width);
  return (
    <box style={{ width, height: 3, flexDirection: "column", backgroundColor: theme.panel }}>
      <text fg={theme.border}>{rule}</text>
      {currentLine.render("old", width) as ReactNode}
      {currentLine.render("new", width) as ReactNode}
    </box>
  );
}

/** Register Hunk's optional line lens through the same public pane API as user extensions. */
const registerBundledLineLens: ExtensionFactory = (hunk) => {
  hunk.registerPane({
    id: "line-lens",
    title: "Current-line lens",
    placement: "bottom",
    thickness: { preferred: 3, min: 3, max: 3 },
    defaultOpen: false,
    currentLine: true,
    available: ({ currentLine }) => currentLine !== null,
    component: BuiltInLineLens,
  });
};

export default registerBundledLineLens;

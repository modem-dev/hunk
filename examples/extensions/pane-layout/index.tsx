import type { ReactNode } from "react";
import type { ExtensionPaneProps, HunkExtensionAPI } from "hunkdiff/extension";

/** Render one bounded edge pane using only the public geometry and review props. */
function EdgePane({
  files,
  height,
  placement,
  selectedFileId,
  theme,
  width,
}: ExtensionPaneProps): ReactNode {
  const selected = files.find((file) => file.id === selectedFileId);
  return (
    <box
      style={{
        width,
        height,
        overflow: "hidden",
        backgroundColor: theme.panel,
        flexDirection: "column",
      }}
    >
      <text fg={theme.accent}>{`${placement.toUpperCase()} PANE · ${width}×${height}`}</text>
      <text fg={theme.text}>{selected?.path ?? `${files.length} visible files`}</text>
    </box>
  );
}

/** Register resizable side content plus fixed top and bottom status strips. */
export default function registerPaneLayout(hunk: HunkExtensionAPI) {
  hunk.registerPane({
    id: "side",
    title: "Pane example · side",
    placement: "right",
    thickness: { preferred: 28, min: 18, max: 44 },
    component: EdgePane,
  });
  for (const placement of ["top", "bottom"] as const) {
    hunk.registerPane({
      id: placement,
      title: `Pane example · ${placement}`,
      placement,
      thickness: { preferred: 2, min: 2, max: 2 },
      component: EdgePane,
    });
  }

  hunk.registerCommand(
    { id: "toggle", title: "Toggle pane layout example", key: "ctrl+p" },
    (ctx) => {
      const ids = ["side", "top", "bottom"] as const;
      const close = ids.some((id) => ctx.panes.isOpen(id));
      for (const id of ids) {
        if (close) ctx.panes.close(id);
        else ctx.panes.open(id);
      }
    },
  );
}

/** Show clickable staged/unstaged stream tabs and the current file action. */
import { MouseButton } from "@opentui/core";
import type { ExtensionWorkingTreePane } from "../../../extension-api/types";
import type { AppTheme } from "../../themes";
import { fitText } from "../../lib/text";

export function WorkingTreeBar({
  pane,
  theme,
  width,
  canToggle,
  hunkFocused = false,
  switchView,
  toggleSelected,
}: {
  pane: ExtensionWorkingTreePane;
  theme: AppTheme;
  width: number;
  canToggle: boolean;
  hunkFocused?: boolean;
  switchView: (staged: boolean) => void;
  toggleSelected: () => void;
}) {
  const selected = pane.files.find((file) => file.path === pane.selectedPath);
  const stage = hunkFocused ? !pane.staged : selected?.unstaged;
  const action = pane.busy
    ? "Working…"
    : `${stage ? "Stage" : "Unstage"} ${hunkFocused ? "hunk" : "file"}`;
  const tabs = [false, true].map((staged) => ({
    staged,
    label: ` ${width < 40 ? (staged ? "S" : "U") : staged ? "Staged" : "Unstaged"} (${pane.files.filter((file) => (staged ? file.staged : file.unstaged)).length}) `,
  }));
  const remainingWidth = Math.max(
    0,
    width - tabs.reduce((total, tab) => total + tab.label.length, 0),
  );
  return (
    <box height={1} width="100%" flexDirection="row" backgroundColor={theme.panel}>
      {tabs.map(({ staged, label }) => (
        <box
          key={String(staged)}
          height={1}
          onMouseUp={(event) => {
            if (event.button === MouseButton.LEFT) switchView(staged);
          }}
        >
          <text fg={pane.staged === staged ? theme.accent : theme.muted}>{label}</text>
        </box>
      ))}
      <box
        height={1}
        onMouseUp={(event) => {
          if (event.button === MouseButton.LEFT && canToggle) toggleSelected();
        }}
      >
        <text fg={canToggle && !pane.busy ? theme.text : theme.muted}>
          {fitText(`  ${action}`, remainingWidth)}
        </text>
      </box>
    </box>
  );
}

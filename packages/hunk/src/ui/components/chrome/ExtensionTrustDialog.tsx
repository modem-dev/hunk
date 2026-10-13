import { relative } from "node:path";
import type { RepoExtensionSnapshot } from "../../../extensions/types";
import { formatTerminalPath } from "../../../lib/terminalText";
import type { AppTheme } from "../../themes";
import { ConfirmDialog, confirmDialogHeight } from "./ConfirmDialog";

/** Show captured entry paths and the approval boundary while keeping review available underneath. */
export function ExtensionTrustDialog({
  repoRoot,
  snapshot,
  terminalHeight,
  terminalWidth,
  theme,
  onTrust,
  onDeny,
  onClose,
}: {
  repoRoot: string;
  snapshot?: RepoExtensionSnapshot;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onTrust: () => void;
  onDeny: () => void;
  onClose: () => void;
}) {
  const entries = snapshot?.entries ?? [];
  const paths = entries
    .slice(0, 3)
    .map((entry) => formatTerminalPath(relative(repoRoot, entry.candidate.path)));
  const omittedEntries = entries.length - paths.length;
  const rows = [
    "Repo extensions (.hunk/extensions or config paths) need approval.",
    "Their dependency snapshot runs with your user permissions.",
    formatTerminalPath(repoRoot),
    ...paths,
    ...(omittedEntries > 0
      ? [
          `+ ${omittedEntries} more ${omittedEntries === 1 ? "entry" : "entries"} (inspect repo config paths)`,
        ]
      : []),
    ...(snapshot
      ? [`Approve all ${entries.length} entries • snapshot ${snapshot.fingerprint.slice(0, 12)}`]
      : []),
    "Trust approves this snapshot; changed code needs new approval.",
  ];

  return (
    <ConfirmDialog
      actions={[
        { keyLabel: "enter/t", label: "trust", run: onTrust },
        { keyLabel: "esc", label: "not now", run: onClose },
        { keyLabel: "n", label: "never", run: onDeny },
      ]}
      height={confirmDialogHeight(rows.length)}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Run this repository's extensions?"
      width={72}
      onClose={onClose}
    >
      {rows.map((row, index) => (
        <box key={index} style={{ width: "100%", height: 1 }}>
          <text fg={theme.muted} wrapMode="none">
            {row}
          </text>
        </box>
      ))}
    </ConfirmDialog>
  );
}

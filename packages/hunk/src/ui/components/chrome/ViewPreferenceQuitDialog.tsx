import type { ViewPreferenceQuitController } from "../../hooks/useViewPreferenceQuitController";
import type { AppTheme } from "../../themes";
import { ConfirmDialog, confirmDialogHeight } from "./ConfirmDialog";

/** Render the shared save-or-discard prompt for changed view preferences. */
export function ViewPreferenceQuitDialog({
  controller,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  controller: ViewPreferenceQuitController;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  const {
    changedViewPreferences,
    viewPreferenceDiffLines,
    viewPreferencesConfigLabel,
    saveViewPreferencesAndQuit,
    discardViewPreferencesAndQuit,
    neverAskToSaveViewPreferencesAndQuit,
    closeSaveConfigPrompt,
  } = controller;

  return (
    <ConfirmDialog
      actions={[
        { keyLabel: "enter/s", label: "save", run: saveViewPreferencesAndQuit },
        { keyLabel: "q", label: "discard", run: discardViewPreferencesAndQuit },
        { keyLabel: "n", label: "never ask", run: neverAskToSaveViewPreferencesAndQuit },
        { keyLabel: "esc", label: "cancel", run: closeSaveConfigPrompt },
      ]}
      height={confirmDialogHeight(4 + viewPreferenceDiffLines.length)}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Save view preferences?"
      width={68}
      onClose={closeSaveConfigPrompt}
    >
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.muted}>
          You changed {changedViewPreferences.length} view{" "}
          {changedViewPreferences.length === 1 ? "setting" : "settings"} during this session.
        </text>
      </box>
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.muted}>
          Save {changedViewPreferences.length === 1 ? "it" : "them"} to your config before quitting?
        </text>
      </box>
      <box style={{ width: "100%", height: 1 }} />
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.badgeNeutral}>{viewPreferencesConfigLabel}</text>
      </box>
      {viewPreferenceDiffLines.map((line) => (
        <box key={line.text} style={{ width: "100%", height: 1 }}>
          <text fg={line.removed ? theme.badgeRemoved : theme.badgeAdded}>{line.text}</text>
        </box>
      ))}
    </ConfirmDialog>
  );
}

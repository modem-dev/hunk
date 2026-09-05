/** Render exact-file discard choices and stash input using the shared confirmation chrome. */
import type { ExtensionVcsDiscardScope } from "../../../extension-api/types";
import type { WorkingTreePrompt } from "../../hooks/useWorkingTreeActions";
import type { AppTheme } from "../../themes";
import { fitText, wrapTextByWidth } from "../../lib/text";
import { resolveModalGeometry } from "../../lib/modalGeometry";
import { ConfirmDialog, confirmDialogHeight } from "./ConfirmDialog";

export function WorkingTreeDialog({
  prompt,
  message,
  onChangeMessage,
  onAccept,
  onCancel,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  prompt: WorkingTreePrompt;
  message: string;
  onChangeMessage: (value: string) => void;
  onAccept: (scope?: ExtensionVcsDiscardScope) => void;
  onCancel: () => void;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  const frame = resolveModalGeometry({
    width: 88,
    height: Number.MAX_SAFE_INTEGER,
    terminalWidth,
    terminalHeight,
  });
  const width = frame.width;
  const bodyWidth = Math.max(1, width - 4);
  const stash = prompt.kind === "stash";
  const unstaged = prompt.file.staged && prompt.file.unstaged;
  const compact = bodyWidth < 60;
  const availableRows = Math.max(0, frame.height - confirmDialogHeight(0));
  const fieldRows = availableRows > 0 ? 1 : 0;
  const explanationRows = availableRows > fieldRows ? 1 : 0;
  const pathRows = Math.max(0, availableRows - fieldRows - explanationRows);
  // Quote control characters and preserve every filename space instead of treating paths as prose.
  const pathLines = wrapTextByWidth(JSON.stringify(prompt.file.path), bodyWidth).map(
    (chunk) => chunk.text,
  );
  const visiblePath =
    pathLines.length <= pathRows
      ? pathLines
      : [...pathLines.slice(0, Math.max(0, pathRows - 1)), ...(pathRows ? ["…"] : [])];
  return (
    <ConfirmDialog
      title={stash ? "Stash selected file" : "Discard changes"}
      width={width}
      height={confirmDialogHeight(visiblePath.length + explanationRows + fieldRows)}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      onClose={onCancel}
      actions={
        stash
          ? [
              { keyLabel: "enter", label: "stash", run: () => onAccept() },
              { keyLabel: "esc", label: bodyWidth < 37 ? "" : "cancel", run: onCancel },
            ]
          : [
              {
                keyLabel: compact ? "x" : "enter/x",
                label: compact ? (bodyWidth < 24 ? "" : "all") : "discard all",
                run: () => onAccept("all"),
              },
              ...(unstaged
                ? [
                    {
                      keyLabel: "u",
                      label: compact ? (bodyWidth < 24 ? "" : "unstaged") : "unstaged only",
                      run: () => onAccept("unstaged"),
                    },
                  ]
                : []),
              { keyLabel: "esc", label: bodyWidth < 37 ? "" : "cancel", run: onCancel },
            ]
      }
    >
      {visiblePath.map((line, index) => (
        <box key={index} height={1}>
          <text fg={theme.text}>{line}</text>
        </box>
      ))}
      {explanationRows > 0 ? (
        <box height={1}>
          <text fg={theme.muted}>
            {fitText(
              stash ? "Only this file. Message (optional):" : "Cannot undo discarded changes.",
              bodyWidth,
            )}
          </text>
        </box>
      ) : null}
      {fieldRows > 0 ? (
        <box height={1} width="100%">
          {stash ? (
            <input
              width={bodyWidth}
              value={message}
              placeholder="Stash message"
              focused={true}
              onInput={onChangeMessage}
            />
          ) : (
            <text fg={theme.muted}>
              {fitText(
                unstaged
                  ? "Unstaged only keeps this file's staged changes."
                  : "Unstaged-only discard is unavailable for this file.",
                bodyWidth,
              )}
            </text>
          )}
        </box>
      ) : null}
    </ConfirmDialog>
  );
}

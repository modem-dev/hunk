import { isEscapeKey } from "../../lib/keyboard";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

export function AgentCommentDialog({
  comment,
  selectedTextAvailable,
  targetLabel,
  terminalHeight,
  terminalWidth,
  theme,
  onCancel,
  onChange,
  onSubmit,
}: {
  comment: string;
  selectedTextAvailable: boolean;
  targetLabel: string;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const width = Math.min(82, Math.max(48, terminalWidth - 8));
  const bodyWidth = Math.max(1, width - 4);

  return (
    <ModalFrame
      height={10}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Comment for agent prompt"
      width={width}
      onClose={onCancel}
    >
      <box style={{ width: "100%", flexDirection: "column", gap: 1 }}>
        <text fg={theme.muted}>{targetLabel}</text>
        <input
          width={bodyWidth}
          value={comment}
          placeholder="Add a note for your coding agent..."
          focused={true}
          onInput={onChange}
          onSubmit={onSubmit}
          onKeyDown={(key) => {
            if (!isEscapeKey(key)) {
              return;
            }

            key.preventDefault();
            key.stopPropagation();
            onCancel();
          }}
        />
        <text fg={theme.muted}>
          {selectedTextAvailable
            ? "Enter submits. Esc cancels. Your selected text will be included."
            : "Enter submits. Esc cancels. The focused hunk will be included."}
        </text>
      </box>
    </ModalFrame>
  );
}

export function AgentPromptPreviewDialog({
  prompt,
  savedPath,
  terminalHeight,
  terminalWidth,
  theme,
  onClose,
}: {
  prompt: string;
  savedPath?: string;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onClose: () => void;
}) {
  const width = Math.min(96, Math.max(56, terminalWidth - 6));
  const height = Math.min(Math.max(12, terminalHeight - 4), 28);

  return (
    <ModalFrame
      height={height}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Agent prompt"
      width={width}
      onClose={onClose}
    >
      <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
        <text fg={theme.muted}>
          {savedPath
            ? `Clipboard unavailable. Prompt saved to ${savedPath}. Select/copy below if needed.`
            : "Clipboard unavailable. Select/copy the prompt below."}
        </text>
        <box style={{ height: 1 }} />
        <scrollbox focused={false} height="100%" scrollY={true} width="100%">
          <text fg={theme.text}>{prompt}</text>
        </scrollbox>
        <box style={{ height: 1 }} />
        <text fg={theme.muted}>Esc closes</text>
      </box>
    </ModalFrame>
  );
}

import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

export const AGENT_SKILL_COMMAND = "hunk skill path";
export const AGENT_SKILL_PROMPT_ROWS = [
  "Load the Hunk skill and use it for this review.",
  "Run `hunk skill path` to get the skill path.",
];
export const AGENT_SKILL_PROMPT = AGENT_SKILL_PROMPT_ROWS.join(" ");

/** Render copyable setup guidance for connecting an agent to the live Hunk session. */
export function AgentSkillDialog({
  copySupported,
  terminalHeight,
  terminalWidth,
  theme,
  onClose,
  onCopyPrompt,
}: {
  copySupported: boolean;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onClose: () => void;
  onCopyPrompt: () => void;
}) {
  const width = Math.min(84, Math.max(58, terminalWidth - 8));
  const bodyWidth = Math.max(1, width - 4);
  const promptWidth = Math.max(1, bodyWidth - 4);
  const promptRows = AGENT_SKILL_PROMPT_ROWS;
  const cardWidth = Math.max(1, bodyWidth - 4);
  const cardTextWidth = Math.max(1, cardWidth - 4);
  const requiredModalHeight = promptRows.length + 11;
  const modalHeight = Math.min(requiredModalHeight, Math.max(10, terminalHeight - 2));

  const copyLabel = copySupported ? " ⧉  Copy prompt " : " Copy unavailable ";
  return (
    <ModalFrame
      height={modalHeight}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Agent skill"
      width={width}
      onClose={onClose}
    >
      <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.text}>
            {fitText("Teach your agent how to review this Hunk session.", bodyWidth)}
          </text>
        </box>
        <box style={{ width: "100%", height: 1 }} />
        <box style={{ width: "100%", height: 1, paddingLeft: 1 }}>
          <text fg={theme.badgeNeutral}>{fitText("Prompt", promptWidth)}</text>
        </box>
        <box style={{ width: "100%", height: promptRows.length + 2, paddingLeft: 1 }}>
          <box
            style={{
              width: cardWidth,
              height: promptRows.length + 2,
              border: true,
              borderColor: theme.border,
              flexDirection: "column",
              paddingLeft: 1,
              paddingRight: 1,
            }}
          >
            {promptRows.map((line, index) => (
              <box key={`prompt:${index}:${line}`} style={{ width: "100%", height: 1 }}>
                <text fg={theme.text}>{fitText(line, cardTextWidth)}</text>
              </box>
            ))}
          </box>
        </box>
        <box style={{ width: "100%", height: 1 }} />
        <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
          <box
            style={{ backgroundColor: copySupported ? theme.accentMuted : theme.panelAlt }}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              if (copySupported) {
                onCopyPrompt();
              }
            }}
          >
            <text fg={copySupported ? theme.text : theme.muted}>{copyLabel}</text>
          </box>
          <text fg={theme.muted}>{padText("", Math.max(1, bodyWidth - copyLabel.length))}</text>
        </box>
      </box>
    </ModalFrame>
  );
}

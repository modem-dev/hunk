import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { matchesKey, type ExtensionDialogProps, type ExtensionFactory } from "hunkdiff/extension";

export const AGENT_SKILL_COMMAND = "hunk skill path";
export const AGENT_SKILL_PROMPT_ROWS = [
  "Load the Hunk skill and use it for this review.",
  "Run `hunk skill path` to get the skill path.",
] as const;
export const AGENT_SKILL_PROMPT = AGENT_SKILL_PROMPT_ROWS.join(" ");
export const BUNDLED_AGENT_SKILL_COMMAND_ID = "app.openAgentSkill";
export const BUNDLED_AGENT_SKILL_COMMAND_FULL_ID = `hunk.${BUNDLED_AGENT_SKILL_COMMAND_ID}`;

const AGENT_SKILL_BODY = "Teach your agent how to review this Hunk session.";
const AGENT_SKILL_DIALOG_WIDTH = 80;
const AGENT_SKILL_DIALOG_HEIGHT = 9;

/** Wrap Hunk-owned ASCII prose to one component rectangle. */
function wrapWords(text: string, width: number) {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (word.length > safeWidth) {
      if (current) lines.push(current);
      for (let offset = 0; offset < word.length; offset += safeWidth) {
        lines.push(word.slice(offset, offset + safeWidth));
      }
      current = "";
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= safeWidth) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Render Agent Skill onboarding through the public custom-dialog contract. */
export function AgentSkillDialog({
  actions,
  copySupported,
  height,
  theme,
  width,
}: ExtensionDialogProps) {
  const bodyLines = wrapWords(AGENT_SKILL_BODY, width);
  const promptWidth = Math.max(1, width - 4);
  const promptLines = AGENT_SKILL_PROMPT_ROWS.flatMap((line) => wrapWords(line, promptWidth));
  const requiredHeight = bodyLines.length + promptLines.length + 6;
  const copyExposed = width >= 5 && height >= requiredHeight;

  const copyPrompt = () => {
    const copied = actions.copy(AGENT_SKILL_PROMPT);
    actions.notify(copied ? "Copied agent skill prompt to clipboard" : "Clipboard copy failed");
  };

  useKeyboard((key) => {
    if (!copySupported || !copyExposed || !matchesKey("c", key)) return;
    key.preventDefault();
    key.stopPropagation();
    copyPrompt();
  });

  return (
    <box style={{ width, height, flexDirection: "column", overflow: "hidden" }}>
      {bodyLines.map((line, index) => (
        <box key={`body:${index}:${line}`} style={{ width: "100%", height: 1 }}>
          <text fg={theme.text}>{line}</text>
        </box>
      ))}
      <box style={{ width: "100%", height: 1 }} />
      <box style={{ width: "100%", height: 1, paddingLeft: 1 }}>
        <text fg={theme.badgeNeutral}>Prompt</text>
      </box>
      <box style={{ width: "100%", height: promptLines.length + 2, paddingLeft: 1 }}>
        <box
          style={{
            width: Math.max(1, width - 1),
            height: promptLines.length + 2,
            flexDirection: "column",
            border: true,
            borderColor: theme.border,
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          {promptLines.map((line, index) => (
            <box key={`prompt:${index}:${line}`} style={{ width: "100%", height: 1 }}>
              <text fg={theme.text}>{line}</text>
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
            if (copySupported && copyExposed) copyPrompt();
          }}
        >
          <text fg={copySupported ? theme.text : theme.muted}>
            {copySupported ? " ⧉  Copy prompt " : " Copy unavailable "}
          </text>
        </box>
      </box>
    </box>
  );
}

/** Register Hunk's agent onboarding guidance through the public dialog contract. */
const registerBundledAgentSkill: ExtensionFactory = (hunk) => {
  hunk.registerCommand(
    {
      id: BUNDLED_AGENT_SKILL_COMMAND_ID,
      title: "Show setup guidance for reviewing with an agent",
    },
    async (ctx) => {
      await ctx.dialogs.open({
        title: "Agent skill",
        width: AGENT_SKILL_DIALOG_WIDTH,
        height: AGENT_SKILL_DIALOG_HEIGHT,
        component: AgentSkillDialog,
      });
    },
  );
};

export default registerBundledAgentSkill;

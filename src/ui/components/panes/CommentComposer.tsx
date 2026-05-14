import { useState } from "react";
import type { KeyEvent } from "@opentui/core";
import { isEscapeKey } from "../../lib/keyboard";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

/** Render the inline composer card the user types a single review comment into. */
export function CommentComposer({
  filePath,
  hunkIndex,
  line,
  side,
  theme,
  width,
  onCancel,
  onSubmit,
}: {
  filePath: string;
  hunkIndex: number;
  line: number;
  side: "old" | "new";
  theme: AppTheme;
  width: number;
  onCancel: () => void;
  onSubmit: (summary: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const sideLabel = side === "new" ? "+" : "-";
  const titleText = `Comment · ${filePath}:${sideLabel}${line}@${hunkIndex + 1}   Enter save · Esc cancel`;
  const boxWidth = Math.max(28, Math.min(width - 4, Math.max(28, width - 4)));
  const innerWidth = Math.max(1, boxWidth - 2);
  const topBorder = `┌${"─".repeat(Math.max(0, boxWidth - 2))}┐`;
  const bottomBorder = `└${"─".repeat(Math.max(0, boxWidth - 2))}┘`;
  const boxLeft = Math.min(4, Math.max(0, width - boxWidth));

  const handleKeyDown = (key: KeyEvent) => {
    if (!isEscapeKey(key)) {
      return;
    }

    key.preventDefault();
    key.stopPropagation();
    onCancel();
  };

  const handleSubmit = () => {
    if (draft.trim().length === 0) {
      onCancel();
      return;
    }
    onSubmit(draft);
  };

  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            {topBorder}
          </text>
        </box>
      </box>

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            │
          </text>
        </box>
        <box style={{ width: innerWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteTitleText} bg={theme.noteTitleBackground}>
            {padText(fitText(titleText, innerWidth), innerWidth)}
          </text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            │
          </text>
        </box>
      </box>

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            │
          </text>
        </box>
        <input
          width={innerWidth}
          value={draft}
          placeholder="describe what you want the agent to look at"
          focused={true}
          onInput={setDraft}
          onSubmit={handleSubmit}
          onKeyDown={handleKeyDown}
        />
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            │
          </text>
        </box>
      </box>

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>
            {bottomBorder}
          </text>
        </box>
      </box>
    </box>
  );
}

/** Constant terminal-row height the composer occupies inside the diff stream. */
export const COMMENT_COMPOSER_HEIGHT = 4;

import type { AppCommand } from "../../lib/appCommands";
import { buildHelpSections, type HelpSection } from "../../lib/helpContent";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

/**
 * Render the in-app controls help modal.
 *
 * The rows come from the command table, so what the dialog shows is what the
 * session's keys actually do, remapped or not.
 */
export function HelpDialog({
  commands,
  sections: suppliedSections,
  terminalHeight,
  terminalWidth,
  theme,
  onClose,
}: {
  commands?: readonly AppCommand[];
  sections?: readonly HelpSection[];
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onClose: () => void;
}) {
  const sections = suppliedSections ? [...suppliedSections] : buildHelpSections(commands ?? []);

  const width = Math.max(1, Math.min(74, Math.max(56, terminalWidth - 8), terminalWidth - 2));
  const bodyWidth = Math.max(1, width - 4);
  const rows = sections.flatMap((section) => section.rows);
  const longestKeys = Math.max(0, ...rows.map((row) => row.keys.length));
  const longestDescription = Math.max(0, ...rows.map((row) => row.description.length));
  // Key text is user-controlled once bindings are, so the column is measured
  // rather than guessed — but descriptions are given the room they need first,
  // since a truncated key is still recognizable and a truncated sentence is not.
  const keyWidth = Math.max(
    1,
    Math.min(
      bodyWidth,
      Math.max(Math.min(12, bodyWidth), Math.min(longestKeys + 1, bodyWidth - longestDescription)),
    ),
  );
  const descriptionWidth = Math.max(0, bodyWidth - keyWidth);
  const sectionSpacerRowCount = Math.max(0, sections.length - 1);
  const contentRowCount =
    sections.reduce((rowCount, section) => rowCount + 1 + section.rows.length, 0) +
    sectionSpacerRowCount;
  // ModalFrame contributes the border rows, title row, padding, and one blank spacer row.
  const modalFrameChromeRowCount = 6;
  const requiredModalHeight = contentRowCount + modalFrameChromeRowCount;
  const modalHeight = Math.max(1, Math.min(requiredModalHeight, terminalHeight - 2));
  const shouldScroll = modalHeight < requiredModalHeight;
  const content = (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {sections.map((section, sectionIndex) => (
        <box key={section.title} style={{ width: "100%", flexDirection: "column" }}>
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.badgeNeutral}>{section.title}</text>
          </box>
          {section.rows.map((row) => (
            <box
              key={`${section.title}:${row.description}`}
              style={{ width: "100%", height: 1, flexDirection: "row" }}
            >
              <text fg={theme.accent}>{padText(fitText(row.keys, keyWidth), keyWidth)}</text>
              <text fg={theme.muted}>{fitText(row.description, descriptionWidth)}</text>
            </box>
          ))}
          {sectionIndex < sections.length - 1 ? <box style={{ width: "100%", height: 1 }} /> : null}
        </box>
      ))}
    </box>
  );

  return (
    <ModalFrame
      height={modalHeight}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Controls help"
      width={width}
      onClose={onClose}
    >
      {shouldScroll ? (
        <scrollbox focused={true} height="100%" scrollY={true} width="100%">
          {content}
        </scrollbox>
      ) : (
        content
      )}
    </ModalFrame>
  );
}

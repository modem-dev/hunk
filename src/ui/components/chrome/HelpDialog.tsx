import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

/** Render the keyboard help modal. */
export function HelpDialog({
  canRefresh = false,
  terminalHeight,
  terminalWidth,
  theme,
  onClose,
}: {
  canRefresh?: boolean;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onClose: () => void;
}) {
  const sections = [
    {
      title: "Navigation",
      items: [
        ["↑ / ↓", "move line-by-line"],
        ["Space / f", "page down (alt: f)"],
        ["b", "page up"],
        ["Shift+Space", "page up (alt)"],
        ["d / u", "half page down / up"],
        ["[ / ]", "previous / next hunk"],
        ["Home / End", "jump to top / bottom"],
      ],
    },
    {
      title: "View",
      items: [
        ["1 / 2 / 0", "split / stack / auto"],
        ["s / t", "sidebar / theme"],
        ["a", "toggle AI notes"],
        ["l / w / m", "lines / wrap / metadata"],
      ],
    },
    {
      title: "Review",
      items: [
        ["/", "focus file filter"],
        ["Tab", "swap files / filter focus"],
        ["F10", "open menus"],
        [canRefresh ? "r / q" : "q", canRefresh ? "reload / quit" : "quit"],
      ],
    },
  ] as const;

  const width = Math.min(74, Math.max(56, terminalWidth - 8));
  const bodyWidth = Math.max(1, width - 4);
  const keyWidth = Math.min(16, Math.max(12, Math.floor(bodyWidth * 0.28)));
  const descriptionWidth = Math.max(1, bodyWidth - keyWidth);
  const height = Math.min(
    sections.reduce((total, section) => total + 1 + section.items.length, 0) + 3,
    Math.max(8, terminalHeight - 2),
  );

  return (
    <ModalFrame
      height={height}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Keyboard help"
      width={width}
      onClose={onClose}
    >
      {sections.map((section) => (
        <box key={section.title} style={{ flexDirection: "column" }}>
          <text fg={theme.badgeNeutral}>{section.title}</text>
          {section.items.map(([keys, description]) => (
            <box key={`${section.title}:${keys}`} style={{ flexDirection: "row" }}>
              <text fg={theme.accent}>{padText(fitText(keys, keyWidth), keyWidth)}</text>
              <text fg={theme.muted}>{fitText(description, descriptionWidth)}</text>
            </box>
          ))}
        </box>
      ))}
    </ModalFrame>
  );
}

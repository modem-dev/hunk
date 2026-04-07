import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

/** Render the in-app controls help modal. */
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
        ["{ / }", "previous / next comment"],
        ["← / →", "scroll code left / right (Shift = faster)"],
        ["Home / End", "jump to top / bottom"],
      ],
    },
    {
      title: "Mouse",
      items: [
        ["Wheel", "scroll vertically"],
        ["Shift+Wheel", "scroll code horizontally"],
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
        ["Tab", "toggle files/filter focus"],
        ["F10", "open menus"],
        [canRefresh ? "r / q" : "q", canRefresh ? "reload / quit" : "quit"],
      ],
    },
  ] as const;

  const width = Math.min(74, Math.max(56, terminalWidth - 8));
  const bodyWidth = Math.max(1, width - 4);
  const keyWidth = Math.min(16, Math.max(12, Math.floor(bodyWidth * 0.28)));
  const descriptionWidth = Math.max(1, bodyWidth - keyWidth);
  const sectionSpacerRowCount = Math.max(0, sections.length - 1);
  const contentRowCount =
    sections.reduce((rowCount, section) => rowCount + 1 + section.items.length, 0) +
    sectionSpacerRowCount;
  // ModalFrame contributes the border rows, title row, padding, and one blank spacer row.
  const modalFrameChromeRowCount = 6;
  const requiredModalHeight = contentRowCount + modalFrameChromeRowCount;
  const modalHeight = Math.min(requiredModalHeight, Math.max(8, terminalHeight - 2));
  const shouldScroll = modalHeight < requiredModalHeight;
  const content = (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {sections.map((section, sectionIndex) => (
        <box key={section.title} style={{ width: "100%", flexDirection: "column" }}>
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.badgeNeutral}>{section.title}</text>
          </box>
          {section.items.map(([keys, description]) => (
            <box
              key={`${section.title}:${keys}`}
              style={{ width: "100%", height: 1, flexDirection: "row" }}
            >
              <text fg={theme.accent}>{padText(fitText(keys, keyWidth), keyWidth)}</text>
              <text fg={theme.muted}>{fitText(description, descriptionWidth)}</text>
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
        <scrollbox focused={false} height="100%" scrollY={true} width="100%">
          {content}
        </scrollbox>
      ) : (
        content
      )}
    </ModalFrame>
  );
}

import type { AgentAnnotation, LayoutMode } from "../../../core/types";
import { wrapText } from "../../lib/agentPopover";
import { annotationRangeLabel } from "../../lib/agentAnnotations";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

function inlineNoteTitle(noteIndex: number, noteCount: number, isUserAuthored: boolean) {
  const label = isUserAuthored ? "My note" : "AI note";
  return noteCount > 1 ? `${label} ${noteIndex + 1}/${noteCount}` : label;
}

/** Resolve the framed note palette — user-authored notes get the warmer orange treatment. */
function inlineNotePalette(theme: AppTheme, isUserAuthored: boolean) {
  if (isUserAuthored) {
    return {
      border: theme.userNoteBorder,
      background: theme.userNoteBackground,
      titleBackground: theme.userNoteTitleBackground,
      titleText: theme.userNoteTitleText,
    };
  }

  return {
    border: theme.noteBorder,
    background: theme.noteBackground,
    titleBackground: theme.noteTitleBackground,
    titleText: theme.noteTitleText,
  };
}

interface AgentInlineNoteLine {
  kind: "summary" | "rationale";
  text: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function splitColumnWidths(width: number) {
  const markerWidth = 1;
  const separatorWidth = 1;
  const usableWidth = Math.max(0, width - markerWidth - separatorWidth);
  const leftWidth = Math.max(0, markerWidth + Math.floor(usableWidth / 2));
  const rightWidth = Math.max(0, separatorWidth + usableWidth - Math.floor(usableWidth / 2));
  return { leftWidth, rightWidth };
}

export function measureAgentInlineNoteHeight({
  annotation,
  anchorSide,
  layout,
  width,
}: {
  annotation: AgentAnnotation;
  anchorSide?: "old" | "new";
  layout: Exclude<LayoutMode, "auto">;
  width: number;
}) {
  const splitWidths = splitColumnWidths(width);
  const canDockRight = layout === "split" && anchorSide === "new" && width >= 84;
  const canDockLeft = layout === "split" && anchorSide === "old" && width >= 84;
  const preferredDockWidth = canDockRight
    ? splitWidths.rightWidth
    : canDockLeft
      ? splitWidths.leftWidth
      : Math.max(34, width - 4);
  const boxWidth = clamp(preferredDockWidth, 28, Math.max(28, width - 4));
  const innerWidth = Math.max(1, boxWidth - 2);
  const bodyWidth = innerWidth;
  const lines: AgentInlineNoteLine[] = [
    ...wrapText(annotation.summary, bodyWidth).map((text) => ({ kind: "summary" as const, text })),
    ...(annotation.rationale
      ? wrapText(annotation.rationale, bodyWidth).map((text) => ({
          kind: "rationale" as const,
          text,
        }))
      : []),
  ];

  // top border + title row + body lines + bottom border
  return 3 + lines.length;
}

/** Render the note card itself before the start of an annotated range. */
export function AgentInlineNote({
  annotation,
  anchorSide,
  layout,
  noteCount = 1,
  noteIndex = 0,
  onClose,
  theme,
  width,
}: {
  annotation: AgentAnnotation;
  anchorSide?: "old" | "new";
  layout: Exclude<LayoutMode, "auto">;
  noteCount?: number;
  noteIndex?: number;
  onClose?: () => void;
  theme: AppTheme;
  width: number;
}) {
  const closeText = onClose ? "[x]" : "";
  const isUserAuthored = annotation.source === "user";
  const palette = inlineNotePalette(theme, isUserAuthored);
  const titleText = `${inlineNoteTitle(noteIndex, noteCount, isUserAuthored)} · ${annotationRangeLabel(annotation)}`;
  const splitWidths = splitColumnWidths(width);
  const canDockRight = layout === "split" && anchorSide === "new" && width >= 84;
  const canDockLeft = layout === "split" && anchorSide === "old" && width >= 84;
  const preferredDockWidth = canDockRight
    ? splitWidths.rightWidth
    : canDockLeft
      ? splitWidths.leftWidth
      : Math.max(34, width - 4);
  const boxWidth = clamp(preferredDockWidth, 28, Math.max(28, width - 4));
  const boxLeft = canDockRight
    ? Math.max(0, width - boxWidth)
    : canDockLeft
      ? 0
      : Math.min(4, Math.max(0, width - boxWidth));
  const innerWidth = Math.max(1, boxWidth - 2);
  const titleWidth = Math.max(1, innerWidth - (closeText ? closeText.length + 1 : 0));
  const bodyWidth = innerWidth;
  const lines: AgentInlineNoteLine[] = [
    ...wrapText(annotation.summary, bodyWidth).map((text) => ({ kind: "summary" as const, text })),
    ...(annotation.rationale
      ? wrapText(annotation.rationale, bodyWidth).map((text) => ({
          kind: "rationale" as const,
          text,
        }))
      : []),
  ];
  const topBorder = `┌${"─".repeat(Math.max(0, boxWidth - 2))}┐`;
  const bottomBorder =
    anchorSide === "new" && canDockRight
      ? `└${"─".repeat(Math.max(0, boxWidth - 2))}┤`
      : anchorSide === "old" && canDockLeft
        ? `├${"─".repeat(Math.max(0, boxWidth - 2))}┘`
        : `└${"─".repeat(Math.max(0, boxWidth - 2))}┘`;

  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={palette.border} bg={palette.background}>
            {topBorder}
          </text>
        </box>
      </box>

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={palette.border} bg={palette.background}>
            │
          </text>
        </box>
        <box style={{ width: titleWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={palette.titleText} bg={palette.titleBackground}>
            {padText(fitText(titleText, titleWidth), titleWidth)}
          </text>
        </box>
        {closeText ? (
          <box
            onMouseUp={onClose}
            style={{ width: closeText.length + 1, height: 1, backgroundColor: theme.panel }}
          >
            <text fg={palette.titleText} bg={palette.titleBackground}>{` ${closeText}`}</text>
          </box>
        ) : null}
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={palette.border} bg={palette.background}>
            │
          </text>
        </box>
      </box>

      {lines.map((line, index) => (
        <box
          key={`${line.kind}:${index}`}
          style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}
        >
          <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
            <text>{" ".repeat(boxLeft)}</text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={palette.border} bg={palette.background}>
              │
            </text>
          </box>
          <box style={{ width: bodyWidth, height: 1, backgroundColor: theme.panel }}>
            <text fg={line.kind === "summary" ? theme.text : theme.muted} bg={palette.background}>
              {padText(line.text, bodyWidth)}
            </text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={palette.border} bg={palette.background}>
              │
            </text>
          </box>
        </box>
      ))}

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={palette.border} bg={palette.background}>
            {bottomBorder}
          </text>
        </box>
      </box>
    </box>
  );
}

/** Render the small cap shown after the last diff row in a note's range. */
export function AgentInlineNoteGuideCap({
  side,
  theme,
  width,
}: {
  side: "old" | "new";
  theme: AppTheme;
  width: number;
}) {
  return (
    <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
      {side === "old" ? (
        <>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder}>╵</text>
          </box>
          <box style={{ width: Math.max(0, width - 1), height: 1, backgroundColor: theme.panel }}>
            <text>{" ".repeat(Math.max(0, width - 1))}</text>
          </box>
        </>
      ) : (
        <>
          <box style={{ width: Math.max(0, width - 1), height: 1, backgroundColor: theme.panel }}>
            <text>{" ".repeat(Math.max(0, width - 1))}</text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder}>╵</text>
          </box>
        </>
      )}
    </box>
  );
}

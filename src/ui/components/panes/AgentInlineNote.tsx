import type { AgentAnnotation, LayoutMode } from "../../../core/types";
import { wrapText } from "../../lib/agentPopover";
import { annotationRangeLabel } from "../../lib/agentAnnotations";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

function inlineNoteTitle(noteIndex: number, noteCount: number) {
  return noteCount > 1 ? `AI note ${noteIndex + 1}/${noteCount}` : "AI note";
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
  const titleText = `${inlineNoteTitle(noteIndex, noteCount)} · ${annotationRangeLabel(annotation)}`;
  const splitWidths = splitColumnWidths(width);
  const canDockRight = layout === "split" && anchorSide === "new" && width >= 84;
  const canDockLeft = layout === "split" && anchorSide === "old" && width >= 84;
  const preferredDockWidth = canDockRight
    ? splitWidths.rightWidth
    : canDockLeft
      ? splitWidths.leftWidth
      : Math.max(34, width - 4);
  const boxWidth = clamp(preferredDockWidth, 28, Math.max(28, width - 4));
  const boxLeft = canDockRight ? Math.max(0, width - boxWidth) : canDockLeft ? 0 : Math.min(4, Math.max(0, width - boxWidth));
  const innerWidth = Math.max(1, boxWidth - 2);
  const titleWidth = Math.max(1, innerWidth - (closeText ? closeText.length + 1 : 0));
  const bodyWidth = innerWidth;
  const lines: AgentInlineNoteLine[] = [
    ...wrapText(annotation.summary, bodyWidth).map((text) => ({ kind: "summary" as const, text })),
    ...(annotation.rationale ? wrapText(annotation.rationale, bodyWidth).map((text) => ({ kind: "rationale" as const, text })) : []),
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
          <text fg={theme.noteBorder} bg={theme.noteBackground}>{topBorder}</text>
        </box>
      </box>

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>│</text>
        </box>
        <box style={{ width: titleWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteTitleText} bg={theme.noteTitleBackground}>{padText(fitText(titleText, titleWidth), titleWidth)}</text>
        </box>
        {closeText ? (
          <box onMouseUp={onClose} style={{ width: closeText.length + 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteTitleText} bg={theme.noteTitleBackground}>{` ${closeText}`}</text>
          </box>
        ) : null}
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>│</text>
        </box>
      </box>

      {lines.map((line, index) => (
        <box key={`${line.kind}:${index}`} style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
          <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
            <text>{" ".repeat(boxLeft)}</text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder} bg={theme.noteBackground}>│</text>
          </box>
          <box style={{ width: bodyWidth, height: 1, backgroundColor: theme.panel }}>
            <text fg={line.kind === "summary" ? theme.text : theme.muted} bg={theme.noteBackground}>
              {padText(line.text, bodyWidth)}
            </text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder} bg={theme.noteBackground}>│</text>
          </box>
        </box>
      ))}

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.noteBackground}>{bottomBorder}</text>
        </box>
      </box>

      {(anchorSide === "new" || anchorSide === "old") && layout === "split" ? (
        <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
          {anchorSide === "old" ? (
            <>
              <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
                <text fg={theme.noteBorder}>│</text>
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
                <text fg={theme.noteBorder}>│</text>
              </box>
            </>
          )}
        </box>
      ) : null}
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

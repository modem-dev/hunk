import type { TextareaRenderable } from "@opentui/core";
import { flushSync } from "@opentui/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentAnnotation, DiffFile, LayoutMode } from "../../../core/types";
import { isEscapeKey, isSaveDraftNoteKey } from "../../lib/keyboard";
import { wrapText } from "../../lib/agentPopover";
import { annotationRangeLabel, reviewNoteSource } from "../../lib/agentAnnotations";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

export function inlineNoteTitle(annotation: AgentAnnotation, noteIndex: number, noteCount: number) {
  if (annotation.source === "user-draft") {
    return "Draft note";
  }

  const source = reviewNoteSource(annotation);
  const author = annotation.author?.trim();
  const label = source === "user" ? "Your note" : author ? `${author} note` : "Agent note";
  return noteCount > 1 ? `${label} ${noteIndex + 1}/${noteCount}` : label;
}

interface AgentInlineNoteLine {
  kind: "summary" | "rationale";
  text: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function draftLineCount(text: string) {
  return Math.max(1, text.split("\n").length);
}

/** Estimate the textarea's wrapped visual row count for a given content width. */
function draftVisualLineCount(text: string, width: number) {
  const usableWidth = Math.max(1, width);
  return Math.max(
    1,
    text
      .split("\n")
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / usableWidth)), 0),
  );
}

function isNewlineKey(key: { ctrl?: boolean; name?: string; sequence?: string }) {
  return (
    key.name === "return" ||
    key.name === "enter" ||
    key.name === "linefeed" ||
    key.sequence === "\r" ||
    key.sequence === "\n" ||
    (key.ctrl && key.name === "j")
  );
}

/** Wrap text while preserving author-entered line breaks in review notes. */
function wrapNoteText(text: string, width: number) {
  return text.split("\n").flatMap((line) => wrapText(line, width));
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
  const contentWidth = Math.max(1, bodyWidth - 2);
  const lines: AgentInlineNoteLine[] = [
    ...wrapNoteText(annotation.summary, contentWidth).map((text) => ({
      kind: "summary" as const,
      text,
    })),
    ...(annotation.rationale
      ? wrapNoteText(annotation.rationale, contentWidth).map((text) => ({
          kind: "rationale" as const,
          text,
        }))
      : []),
  ];

  if (annotation.source === "user-draft") {
    // Keep geometry aligned with the rendered textarea rows, including soft wraps.
    return draftVisualLineCount(annotation.summary, contentWidth) + 6;
  }

  // top border + title row + body lines + bottom border
  return 3 + lines.length;
}

/** Render the note card itself before the start of an annotated range. */
export function AgentInlineNote({
  annotation,
  anchorSide,
  file,
  layout,
  noteCount = 1,
  noteIndex = 0,
  draft,
  onClose,
  theme,
  width,
}: {
  annotation: AgentAnnotation;
  anchorSide?: "old" | "new";
  file?: DiffFile;
  layout: Exclude<LayoutMode, "auto">;
  noteCount?: number;
  noteIndex?: number;
  draft?: {
    body: string;
    focused: boolean;
    onBlur?: () => void;
    onCancel: () => void;
    onFocus?: () => void;
    onInput: (value: string) => void;
    onSave: () => void;
  };
  onClose?: () => void;
  theme: AppTheme;
  width: number;
}) {
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const [draftLineCountHint, setDraftLineCountHint] = useState(() =>
    draftLineCount(draft?.body ?? ""),
  );

  useEffect(() => {
    setDraftLineCountHint(draftLineCount(draft?.body ?? ""));
  }, [draft?.body]);

  useLayoutEffect(() => {
    if (!draft) {
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const originalFocus = textarea.focus.bind(textarea);
    const originalBlur = textarea.blur.bind(textarea);
    let active = true;

    textarea.focus = () => {
      originalFocus();
      if (active) {
        draft.onFocus?.();
      }
    };

    textarea.blur = () => {
      originalBlur();
      if (active) {
        draft.onBlur?.();
      }
    };

    return () => {
      active = false;
      textarea.focus = originalFocus;
      textarea.blur = originalBlur;
    };
  }, [draft]);

  const closeText = onClose ? "[x]" : "";
  const titleText = `${inlineNoteTitle(annotation, noteIndex, noteCount)} - ${annotationRangeLabel(annotation, file)}`;
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
  const closeGapWidth = closeText ? 1 : 0;
  const closeWidth = closeText.length;
  const bodyWidth = innerWidth;
  const contentWidth = Math.max(1, bodyWidth - 2);
  const draftInnerWidth = Math.max(1, boxWidth - 2);
  const draftContentWidth = Math.max(1, draftInnerWidth - 2);
  const draftVisibleRows = draft
    ? Math.max(draftLineCountHint, draftVisualLineCount(draft.body, draftContentWidth))
    : 0;

  useLayoutEffect(() => {
    if (!draft || draftVisibleRows <= 0) {
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const viewport = textarea.editorView.getViewport();
    if (viewport.offsetY === 0 && viewport.height === draftVisibleRows) {
      return;
    }

    // The textarea follows the cursor after Enter while its old one-line viewport is still active.
    // Once the composer grows to fit the new line, reset the viewport so previous lines stay visible.
    textarea.editorView.setViewport(viewport.offsetX, 0, viewport.width, draftVisibleRows, false);
    textarea.requestRender();
  }, [draft, draftVisibleRows]);

  const updateDraftLineCountHint = (nextLineCount: number) => {
    flushSync(() => {
      setDraftLineCountHint(nextLineCount);
    });
  };

  const lines: AgentInlineNoteLine[] = [
    ...wrapNoteText(annotation.summary, contentWidth).map((text) => ({
      kind: "summary" as const,
      text,
    })),
    ...(annotation.rationale
      ? wrapNoteText(annotation.rationale, contentWidth).map((text) => ({
          kind: "rationale" as const,
          text,
        }))
      : []),
  ];
  const savedTitleText = fitText(
    ` ${titleText} `,
    Math.max(0, boxWidth - 4 - closeGapWidth - closeWidth),
  );
  const savedTopBorderSuffixWidth = Math.max(
    0,
    boxWidth - 3 - savedTitleText.length - closeGapWidth - closeWidth,
  );
  const savedTopPrefixWidth = 2 + savedTitleText.length + savedTopBorderSuffixWidth;
  const bottomBorder = `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`;

  if (draft) {
    const draftVisibleLineCount = draftVisibleRows;
    const draftTitleText = fitText(` ${titleText} `, Math.max(0, boxWidth - 4));
    const saveInnerWidth = 11;
    const cancelInnerWidth = 14;
    const footerRemainderWidth = Math.max(0, boxWidth - saveInnerWidth - cancelInnerWidth - 4);
    const draftTopBorderSuffix = `${"─".repeat(Math.max(0, boxWidth - 3 - draftTitleText.length))}╮`;
    const footerButtonWidth = 1 + saveInnerWidth + 1 + cancelInnerWidth + 1;
    const footerButtonLeft = boxLeft + footerRemainderWidth + 1;
    const draftActionBorder = `╰${"─".repeat(footerRemainderWidth)}┬${"─".repeat(saveInnerWidth)}┬${"─".repeat(cancelInnerWidth)}┤`;
    const draftButtonBottom = `╰${"─".repeat(saveInnerWidth)}┴${"─".repeat(cancelInnerWidth)}╯`;
    const draftTextareaRows = draftVisibleLineCount;
    const draftTopPaddingRows = 1;
    const draftBottomPaddingRows = 1;
    const renderDraftBodyPaddingRows = (keyPrefix: string, rowCount: number) =>
      Array.from({ length: rowCount }, (_, rowIndex) => (
        <box
          key={`${keyPrefix}:${rowIndex}`}
          style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}
        >
          <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
            <text>{" ".repeat(boxLeft)}</text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder} bg={theme.panel}>
              │
            </text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }} />
          <box style={{ width: draftContentWidth, height: 1, backgroundColor: theme.panel }}>
            <text bg={theme.panel}>{" ".repeat(draftContentWidth)}</text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }} />
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder} bg={theme.panel}>
              │
            </text>
          </box>
        </box>
      ));

    return (
      <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
        <box
          style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}
        >
          <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
            <text>{" ".repeat(boxLeft)}</text>
          </box>
          <box style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}>
            <text>
              <span fg={theme.noteBorder} bg={theme.panel}>
                ╭─
              </span>
              <span fg={theme.noteTitleText} bg={theme.panel}>
                {draftTitleText}
              </span>
              <span fg={theme.noteBorder} bg={theme.panel}>
                {draftTopBorderSuffix}
              </span>
            </text>
          </box>
        </box>

        {renderDraftBodyPaddingRows("draft-body-top-padding", draftTopPaddingRows)}

        <box
          style={{
            width: "100%",
            height: draftTextareaRows,
            flexDirection: "row",
            backgroundColor: theme.panel,
          }}
        >
          <box
            style={{ width: boxLeft, height: draftTextareaRows, backgroundColor: theme.panel }}
          />
          <box
            style={{
              width: 1,
              height: draftTextareaRows,
              flexDirection: "column",
              backgroundColor: theme.panel,
            }}
          >
            {Array.from({ length: draftTextareaRows }, (_, rowIndex) => (
              <text
                key={`draft-textarea-left-border:${rowIndex}`}
                fg={theme.noteBorder}
                bg={theme.panel}
              >
                │
              </text>
            ))}
          </box>
          <box style={{ width: 1, height: draftTextareaRows, backgroundColor: theme.panel }} />
          <textarea
            ref={textareaRef}
            width={draftContentWidth}
            height={draftTextareaRows}
            initialValue={draft.body}
            placeholder="Write a note…"
            focused={draft.focused}
            backgroundColor={theme.panel}
            textColor={theme.text}
            focusedBackgroundColor={theme.panel}
            focusedTextColor={theme.text}
            keyBindings={[{ name: "j", ctrl: true, action: "newline" }]}
            onContentChange={() => {
              const textarea = textareaRef.current;
              const nextBody = textarea?.plainText ?? "";
              updateDraftLineCountHint(
                Math.max(
                  draftVisualLineCount(nextBody, draftContentWidth),
                  textarea?.virtualLineCount ?? 0,
                ),
              );
              draft.onInput(nextBody);
            }}
            onKeyDown={(key) => {
              if (isNewlineKey(key)) {
                updateDraftLineCountHint(
                  draftVisualLineCount(
                    textareaRef.current?.plainText ?? draft.body,
                    draftContentWidth,
                  ) + 1,
                );
              }

              if (isSaveDraftNoteKey(key)) {
                key.preventDefault();
                key.stopPropagation();
                draft.onSave();
                return;
              }

              if (isEscapeKey(key)) {
                key.preventDefault();
                key.stopPropagation();
                draft.onCancel();
              }
            }}
          />
          <box style={{ width: 1, height: draftTextareaRows, backgroundColor: theme.panel }} />
          <box
            style={{
              width: 1,
              height: draftTextareaRows,
              flexDirection: "column",
              backgroundColor: theme.panel,
            }}
          >
            {Array.from({ length: draftTextareaRows }, (_, rowIndex) => (
              <text
                key={`draft-textarea-right-border:${rowIndex}`}
                fg={theme.noteBorder}
                bg={theme.panel}
              >
                │
              </text>
            ))}
          </box>
        </box>

        {renderDraftBodyPaddingRows("draft-body-bottom-padding", draftBottomPaddingRows)}

        <box
          style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}
        >
          <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
            <text>{" ".repeat(boxLeft)}</text>
          </box>
          <box style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder} bg={theme.panel}>
              {draftActionBorder}
            </text>
          </box>
        </box>

        <box
          style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}
        >
          <box style={{ width: footerButtonLeft, height: 1, backgroundColor: theme.panel }}>
            <text>{" ".repeat(footerButtonLeft)}</text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder} bg={theme.panel}>
              │
            </text>
          </box>
          <box onMouseUp={draft.onSave} style={{ width: saveInnerWidth, height: 1 }}>
            <text fg={theme.noteTitleText} bg={theme.panel}>
              {padText(" Save (^S) ", saveInnerWidth)}
            </text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder} bg={theme.panel}>
              │
            </text>
          </box>
          <box onMouseUp={draft.onCancel} style={{ width: cancelInnerWidth, height: 1 }}>
            <text fg={theme.noteTitleText} bg={theme.panel}>
              {padText(" Cancel (Esc) ", cancelInnerWidth)}
            </text>
          </box>
          <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder} bg={theme.panel}>
              │
            </text>
          </box>
        </box>

        <box
          style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}
        >
          <box style={{ width: footerButtonLeft, height: 1, backgroundColor: theme.panel }}>
            <text>{" ".repeat(footerButtonLeft)}</text>
          </box>
          <box style={{ width: footerButtonWidth, height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.noteBorder} bg={theme.panel}>
              {draftButtonBottom}
            </text>
          </box>
        </box>
      </box>
    );
  }

  const renderSavedBodyRow = (key: string, text: string, kind: AgentInlineNoteLine["kind"]) => (
    <box
      key={key}
      style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}
    >
      <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
        <text>{" ".repeat(boxLeft)}</text>
      </box>
      <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
        <text fg={theme.noteBorder} bg={theme.panel}>
          │
        </text>
      </box>
      <box style={{ width: 1, height: 1, backgroundColor: theme.panel }} />
      <box style={{ width: contentWidth, height: 1, backgroundColor: theme.panel }}>
        <text fg={kind === "summary" ? theme.text : theme.muted} bg={theme.panel}>
          {padText(text, contentWidth)}
        </text>
      </box>
      <box style={{ width: 1, height: 1, backgroundColor: theme.panel }} />
      <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
        <text fg={theme.noteBorder} bg={theme.panel}>
          │
        </text>
      </box>
    </box>
  );

  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: savedTopPrefixWidth, height: 1, backgroundColor: theme.panel }}>
          <text>
            <span fg={theme.noteBorder} bg={theme.panel}>
              ╭─
            </span>
            <span fg={theme.noteTitleText} bg={theme.panel}>
              {savedTitleText}
            </span>
            <span fg={theme.noteBorder} bg={theme.panel}>
              {"─".repeat(savedTopBorderSuffixWidth)}
            </span>
          </text>
        </box>
        {closeText ? (
          <box style={{ width: closeGapWidth, height: 1, backgroundColor: theme.panel }}>
            <text bg={theme.panel}>{" ".repeat(closeGapWidth)}</text>
          </box>
        ) : null}
        {closeText ? (
          <box
            onMouseUp={onClose}
            style={{ width: closeWidth, height: 1, backgroundColor: theme.panel }}
          >
            <text fg={theme.noteTitleText} bg={theme.panel}>
              {closeText}
            </text>
          </box>
        ) : null}
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.panel}>
            ╮
          </text>
        </box>
      </box>

      {renderSavedBodyRow("saved-note-top-padding", "", "summary")}

      {lines.map((line, index) =>
        renderSavedBodyRow(`${line.kind}:${index}`, line.text, line.kind),
      )}

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text>{" ".repeat(boxLeft)}</text>
        </box>
        <box style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.panel}>
            {bottomBorder}
          </text>
        </box>
      </box>
    </box>
  );
}

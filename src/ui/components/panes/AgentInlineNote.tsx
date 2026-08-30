import {
  createTextAttributes,
  EditBuffer,
  EditorView,
  type TextareaRenderable,
} from "@opentui/core";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DiffFile } from "../../../core/changeset/model";
import type { LayoutMode } from "../../../core/run/commandInputs";
import type { AgentAnnotation } from "../../../extension-api/types";
import { agentNoteBoxLayout } from "../../lib/agentNoteGeometry";
import {
  annotationRangeLabel,
  inlineNoteTitle,
  type VisibleAgentNote,
} from "../../lib/agentAnnotations";
import { fileLabel } from "../../lib/files";
import { wrapText } from "../../lib/text";

import { sanitizeTerminalLine } from "../../../lib/terminalText";
import { fitText, measureTextWidth, padText, sliceTextByWidth } from "../../lib/text";
import { resolveStmlColor } from "../../lib/stml/colors";
import { layoutStmlCached, type StmlLine, type StmlSpan } from "../../lib/stml/layout";
import type { AppTheme } from "../../themes";

export interface AgentInlineNoteActions {
  onEdit?: () => void;
  onReply?: () => void;
  onDelete?: () => void;
}

interface BorderActionItem {
  id: string;
  keyLabel: string;
  label: string;
  onMouseUp: () => void;
}

interface AgentInlineNoteLine {
  kind: "summary" | "rationale";
  text: string;
}

/**
 * Lay out an annotation's optional STML markup body for one content width.
 *
 * Returns null when the annotation has no markup or the markup degrades to
 * nothing, so callers fall back to the plain summary/rationale body. Both
 * measurement and rendering call this with the same width, which keeps the
 * planned row height and the mounted card height in exact lockstep.
 */
export function agentInlineNoteMarkupLines(
  annotation: AgentAnnotation,
  contentWidth: number,
): StmlLine[] | null {
  if (!annotation.markup || annotation.source === "user-draft") {
    return null;
  }

  const { lines } = layoutStmlCached(annotation.markup, contentWidth);
  return lines.length > 0 ? lines : null;
}

let draftMeasureView: { buffer: EditBuffer; view: EditorView } | null = null;

/**
 * Count the composer's visual rows for one body at one content width.
 *
 * Measured through the editor's own native buffer because JS width tables
 * disagree with it on some clusters (e.g. an emoji flag followed by a
 * combining mark). This count must match the editor exactly: the
 * row-windowed stream plans note heights from it before the card mounts,
 * and the editor clamps its wrap count to its viewport height, so an
 * undercount would hide rows instead of revealing them.
 */
export function draftVisualLineCount(text: string, width: number) {
  if (!draftMeasureView) {
    const buffer = EditBuffer.create("unicode");
    const view = EditorView.create(buffer, 1, 1);
    view.setWrapMode("char");
    draftMeasureView = { buffer, view };
  }

  const { buffer, view } = draftMeasureView;
  view.setViewport(0, 0, Math.max(1, width), 1);
  buffer.setText(text);
  return view.getTotalVirtualLineCount();
}

/** Wrap text while preserving author-entered line breaks in review notes. */
function wrapNoteText(text: string, width: number) {
  return text.split("\n").flatMap((line) => wrapText(sanitizeTerminalLine(line), width));
}

/** Build the plain summary/rationale body used when a note has no markup. */
/** Format a compact, stable-enough age for a saved comment title. */
export function shortReviewNoteAge(createdAt: string | undefined, now = Date.now()) {
  const timestamp = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d`;
  const elapsedWeeks = Math.floor(elapsedDays / 7);
  if (elapsedWeeks < 52) return `${elapsedWeeks}w`;
  return `${Math.floor(elapsedWeeks / 52)}y`;
}

/** Keep the identifying tail of a path visible inside a fixed terminal-cell width. */
function fitTrailingText(text: string, width: number, overflowMarker = "...") {
  const safeWidth = Math.max(0, width);
  const measuredWidth = measureTextWidth(text);
  if (measuredWidth <= safeWidth) {
    return text;
  }
  const marker = fitText(overflowMarker, safeWidth, "");
  const markerWidth = measureTextWidth(marker);
  const tailWidth = Math.max(0, safeWidth - markerWidth);
  return `${marker}${sliceTextByWidth(text, measuredWidth - tailWidth, tailWidth).text}`;
}

/** Build the compact author-and-age title used by semantic thread cards. */
function threadedInlineNoteTitle(annotation: AgentAnnotation) {
  const author = sanitizeTerminalLine(annotation.author?.trim() ?? "");
  const label = annotation.source === "user" ? "Your note" : author || "Agent note";
  const age = shortReviewNoteAge(annotation.createdAt);
  return `${label}${age ? ` · ${age}` : ""}`;
}

function agentInlineNoteBodyLines(
  annotation: AgentAnnotation,
  contentWidth: number,
): AgentInlineNoteLine[] {
  return [
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
}

export function measureAgentInlineNoteHeight({
  annotation,
  anchorSide,
  layout,
  width,
  threadDepth = 0,
}: {
  annotation: AgentAnnotation;
  anchorSide?: "old" | "new";
  layout: Exclude<LayoutMode, "auto">;
  width: number;
  actions?: AgentInlineNoteActions;
  threadDepth?: number;
}) {
  const { contentWidth } = agentNoteBoxLayout({ anchorSide, layout, width, threadDepth });

  if (annotation.source === "user-draft") {
    // Match saved-card spacing: top border + top padding + textarea rows + bottom border.
    return draftVisualLineCount(annotation.summary, contentWidth) + 3;
  }

  const markupLines = agentInlineNoteMarkupLines(annotation, contentWidth);
  const bodyLineCount = markupLines
    ? markupLines.length
    : agentInlineNoteBodyLines(annotation, contentWidth).length;

  // top border + top padding row + body lines + bottom border. Saved actions replace
  // border cells on hover, so capabilities never change card geometry.
  return 3 + bodyLineCount;
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
  actions,
  onClose,
  thread,
  threadDepth = thread?.depth ?? 0,
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
  actions?: AgentInlineNoteActions;
  /** Legacy compact delete affordance; semantic cards use explicit `actions`. */
  onClose?: () => void;
  thread?: VisibleAgentNote["thread"];
  /** Compatibility input for isolated card callers; render plans pass `thread`. */
  threadDepth?: number;
  theme: AppTheme;
  width: number;
}) {
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const [actionsHovered, setActionsHovered] = useState(false);
  const [hoveredActionId, setHoveredActionId] = useState<string | null>(null);
  const isDraft = Boolean(draft);
  const hasSavedActions = Boolean(actions && Object.values(actions).some(Boolean));

  useEffect(() => {
    if (isDraft || !hasSavedActions) {
      setActionsHovered(false);
    }
    setHoveredActionId(null);
  }, [hasSavedActions, isDraft]);

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

  const rangeLabel = annotationRangeLabel(annotation, file);
  const locationTitle = `${inlineNoteTitle(annotation, noteIndex, noteCount)} - ${rangeLabel}`;
  const titleText =
    !draft && thread ? `${threadedInlineNoteTitle(annotation)} · ${rangeLabel}` : locationTitle;
  const { boxWidth, boxLeft, contentWidth } = agentNoteBoxLayout({
    anchorSide,
    layout,
    width,
    threadDepth,
  });
  const visualThreadDepth = Math.min(Math.max(0, threadDepth), 3);
  const connectorWidth = visualThreadDepth * 2;
  const connectorLeft = Math.max(0, boxLeft - connectorWidth);
  const ancestorGuides = thread?.ancestorHasNextSibling ?? [];
  const displayedAncestorGuides =
    visualThreadDepth > 1 ? ancestorGuides.slice(-(visualThreadDepth - 1)) : [];
  const threadGuideColor = theme.muted;

  /** Draw one tree prefix without changing the card's measured placement. */
  const threadGutterText = (row: "top" | "continuation") => {
    if (!thread || visualThreadDepth === 0) {
      return " ".repeat(boxLeft);
    }

    const segments = Array.from({ length: visualThreadDepth }, (_, depth) => {
      if (depth < visualThreadDepth - 1) {
        return displayedAncestorGuides[depth] ? "│ " : "  ";
      }
      if (row === "top") {
        return thread.hasNextSibling ? "├─" : "╰─";
      }
      return thread.hasNextSibling ? "│ " : "  ";
    });
    return `${" ".repeat(connectorLeft)}${segments.join("")}`;
  };
  const draftInnerWidth = Math.max(1, boxWidth - 2);
  const draftContentWidth = Math.max(1, draftInnerWidth - 2);
  const draftVisibleRows = draft ? draftVisualLineCount(draft.body, draftContentWidth) : 0;

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

  const lines = agentInlineNoteBodyLines(annotation, contentWidth);
  const closeText = onClose ? "[x]" : "";
  const closeGapWidth = closeText ? 1 : 0;
  const closeWidth = closeText.length;
  const savedTitleBudget = Math.max(0, boxWidth - 4 - closeGapWidth - closeWidth);
  const savedTitleText = (() => {
    if (!thread || !file) {
      return fitText(` ${titleText} `, savedTitleBudget);
    }

    const author = threadedInlineNoteTitle(annotation);
    const path = fileLabel(file);
    const range = annotationRangeLabel(annotation);
    // Keep all three identities represented at the minimum card width: author may
    // collapse first, while the path keeps a recognizable tail and the range keeps
    // its leading line address.
    const fixedSeparatorWidth = 6;
    const contentBudget = Math.max(0, savedTitleBudget - fixedSeparatorWidth);
    const rangeBudget = Math.min(
      measureTextWidth(range),
      Math.max(3, Math.floor(contentBudget * 0.4)),
    );
    const remainingBeforeRange = Math.max(0, contentBudget - rangeBudget);
    const pathBudget = Math.min(
      measureTextWidth(path),
      Math.max(6, Math.floor(remainingBeforeRange * 0.55)),
    );
    const authorBudget = Math.max(0, remainingBeforeRange - pathBudget);
    const fittedAuthor = fitText(author, authorBudget, "…");
    const fittedPath = fitTrailingText(path, pathBudget);
    const fittedRange = fitText(range, rangeBudget, "…");
    return ` ${fittedAuthor} · ${fittedPath} ${fittedRange} `;
  })();
  const savedTitleWidth = measureTextWidth(savedTitleText);
  const savedTopBorderSuffixWidth = Math.max(
    0,
    boxWidth - 3 - savedTitleWidth - closeGapWidth - closeWidth,
  );
  const savedTopPrefixWidth = 2 + savedTitleWidth + savedTopBorderSuffixWidth;
  const savedActionItems: BorderActionItem[] = actions
    ? [
        actions.onReply
          ? { id: "reply", keyLabel: "r", label: "reply", onMouseUp: actions.onReply }
          : null,
        actions.onEdit
          ? { id: "edit", keyLabel: "e", label: "edit", onMouseUp: actions.onEdit }
          : null,
        actions.onDelete
          ? { id: "delete", keyLabel: "d", label: "delete", onMouseUp: actions.onDelete }
          : null,
      ].filter((item): item is BorderActionItem => item !== null)
    : [];

  /** Render clickable controls in place of the trailing cells of a bottom border. */
  const renderBottomBorder = (items: readonly BorderActionItem[]) => {
    const availableItemsWidth = Math.max(0, boxWidth - 4);
    const fullItemsWidth = items.reduce(
      (total, item, index) =>
        total + item.keyLabel.length + 1 + item.label.length + (index > 0 ? 1 : 0),
      0,
    );
    const renderedItems = items.map((item) => ({
      ...item,
      displayLabel: fullItemsWidth <= availableItemsWidth ? item.label : "",
    }));
    const itemsWidth = renderedItems.reduce(
      (total, item, index) =>
        total +
        item.keyLabel.length +
        (item.displayLabel ? 1 + item.displayLabel.length : 0) +
        (index > 0 ? 1 : 0),
      0,
    );
    const innerWidth = Math.max(0, boxWidth - 2);
    const overlayWidth = itemsWidth + 2;
    const leadingWidth = Math.max(0, innerWidth - overlayWidth);

    return (
      <box
        style={{
          width: boxWidth,
          height: 1,
          flexDirection: "row",
          backgroundColor: theme.panel,
        }}
        onMouseMove={() => setActionsHovered(true)}
        onMouseOver={() => setActionsHovered(true)}
        onMouseOut={() => setActionsHovered(false)}
      >
        <text fg={theme.noteBorder} bg={theme.panel}>
          {`╰${"─".repeat(leadingWidth)} `}
        </text>
        {renderedItems.map((item, index) => {
          const hovered = hoveredActionId === item.id;
          const backgroundColor = hovered ? theme.accentMuted : theme.panel;
          const itemWidth =
            item.keyLabel.length + (item.displayLabel ? 1 + item.displayLabel.length : 0);
          return (
            <box
              key={item.id}
              style={{
                width: itemWidth + (index > 0 ? 1 : 0),
                height: 1,
                flexDirection: "row",
                backgroundColor: theme.panel,
              }}
            >
              {index > 0 ? <text bg={theme.panel}> </text> : null}
              <box
                onMouseOver={() => setHoveredActionId(item.id)}
                onMouseOut={() =>
                  setHoveredActionId((current) => (current === item.id ? null : current))
                }
                onMouseUp={item.onMouseUp}
                style={{ width: itemWidth, height: 1, backgroundColor }}
              >
                <text bg={backgroundColor}>
                  <span fg={theme.noteTitleText}>{item.keyLabel}</span>
                  {item.displayLabel ? (
                    <span fg={hovered ? theme.text : theme.muted}>{` ${item.displayLabel}`}</span>
                  ) : null}
                </text>
              </box>
            </box>
          );
        })}
        <text fg={theme.noteBorder} bg={theme.panel}>
          {" ╯"}
        </text>
      </box>
    );
  };

  if (draft) {
    const draftVisibleLineCount = draftVisibleRows;
    const draftTitleText = fitText(` ${titleText} `, Math.max(0, boxWidth - 4));
    const draftTopBorderSuffix = `${"─".repeat(Math.max(0, boxWidth - 3 - draftTitleText.length))}╮`;
    const draftActionItems: BorderActionItem[] = [
      { id: "save", keyLabel: "^S", label: "save", onMouseUp: draft.onSave },
      { id: "cancel", keyLabel: "Esc", label: "cancel", onMouseUp: draft.onCancel },
    ];
    const draftTextareaRows = draftVisibleLineCount;
    const draftTopPaddingRows = 1;
    const renderDraftBodyPaddingRows = (keyPrefix: string, rowCount: number) =>
      Array.from({ length: rowCount }, (_, rowIndex) => (
        <box
          key={`${keyPrefix}:${rowIndex}`}
          style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}
        >
          <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
            <text fg={threadGuideColor} bg={theme.panel}>
              {threadGutterText("continuation")}
            </text>
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
            <text fg={threadGuideColor} bg={theme.panel}>
              {threadGutterText("top")}
            </text>
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
            style={{
              width: boxLeft,
              height: draftTextareaRows,
              flexDirection: "column",
              backgroundColor: theme.panel,
            }}
          >
            {Array.from({ length: draftTextareaRows }, (_, rowIndex) => (
              <text
                key={`draft-textarea-thread-gutter:${rowIndex}`}
                fg={threadGuideColor}
                bg={theme.panel}
              >
                {threadGutterText("continuation")}
              </text>
            ))}
          </box>
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
            wrapMode="char"
            backgroundColor={theme.panel}
            textColor={theme.text}
            focusedBackgroundColor={theme.panel}
            focusedTextColor={theme.text}
            keyBindings={[{ name: "j", ctrl: true, action: "newline" }]}
            onContentChange={() => {
              const nextBody = textareaRef.current?.plainText ?? "";
              // Deliberately not flushSync: burst input (chunked paste, key
              // repeat) emits many content changes in one stack, and forcing a
              // synchronous render per change nests renders until React hits
              // its nested-update limit. Batched propagation commits before
              // the next frame, so the resize still lands with the edit.
              draft.onInput(nextBody);
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

        <box
          style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}
        >
          <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
            <text fg={threadGuideColor} bg={theme.panel}>
              {threadGutterText("continuation")}
            </text>
          </box>
          {renderBottomBorder(draftActionItems)}
        </box>
      </box>
    );
  }

  const markupLines = agentInlineNoteMarkupLines(annotation, contentWidth);

  /** Resolve one STML span into concrete OpenTUI text props for this theme. */
  const markupSpanProps = (span: StmlSpan) => ({
    fg: resolveStmlColor(span.fg, theme) ?? theme.text,
    bg: resolveStmlColor(span.bg, theme) ?? theme.panel,
    attributes: createTextAttributes({
      bold: span.bold,
      italic: span.italic,
      underline: span.underline,
      dim: span.dim,
      strikethrough: span.strike,
    }),
  });

  /** One card body row: left offset, side borders, and a one-line content cell. */
  const renderBodyRow = (key: string, content: ReactNode) => (
    <box
      key={key}
      style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}
    >
      <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
        <text fg={threadGuideColor} bg={theme.panel}>
          {threadGutterText("continuation")}
        </text>
      </box>
      <box
        style={{
          width: boxWidth,
          height: 1,
          flexDirection: "row",
          backgroundColor: theme.panel,
        }}
        onMouseMove={() => setActionsHovered(true)}
        onMouseOver={() => setActionsHovered(true)}
        onMouseOut={() => setActionsHovered(false)}
      >
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.panel}>
            │
          </text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }} />
        <box style={{ width: contentWidth, height: 1, backgroundColor: theme.panel }}>
          {content}
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }} />
        <box style={{ width: 1, height: 1, backgroundColor: theme.panel }}>
          <text fg={theme.noteBorder} bg={theme.panel}>
            │
          </text>
        </box>
      </box>
    </box>
  );

  const renderMarkupBodyRow = (key: string, line: StmlLine) => {
    const usedWidth = line.spans.reduce((total, span) => total + measureTextWidth(span.text), 0);
    return renderBodyRow(
      key,
      <text bg={theme.panel}>
        {line.spans.map((span, spanIndex) => (
          <span key={`${key}:span:${spanIndex}`} {...markupSpanProps(span)}>
            {span.text}
          </span>
        ))}
        {usedWidth < contentWidth ? (
          <span bg={theme.panel}>{" ".repeat(contentWidth - usedWidth)}</span>
        ) : null}
      </text>,
    );
  };

  const renderSavedBodyRow = (key: string, text: string, kind: AgentInlineNoteLine["kind"]) =>
    renderBodyRow(
      key,
      <text fg={kind === "summary" ? theme.text : theme.muted} bg={theme.panel}>
        {padText(text, contentWidth)}
      </text>,
    );

  const bottomBorderInnerWidth = Math.max(0, boxWidth - 2);
  const showActionOverlay = actionsHovered && savedActionItems.length > 0;

  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text fg={threadGuideColor} bg={theme.panel}>
            {threadGutterText("top")}
          </text>
        </box>
        <box
          style={{
            width: boxWidth,
            height: 1,
            flexDirection: "row",
            backgroundColor: theme.panel,
          }}
          onMouseMove={() => setActionsHovered(true)}
          onMouseOver={() => setActionsHovered(true)}
          onMouseOut={() => setActionsHovered(false)}
        >
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
      </box>

      {renderSavedBodyRow("saved-note-top-padding", "", "summary")}

      {markupLines
        ? markupLines.map((line, index) => renderMarkupBodyRow(`markup:${index}`, line))
        : lines.map((line, index) =>
            renderSavedBodyRow(`${line.kind}:${index}`, line.text, line.kind),
          )}

      <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
        <box style={{ width: boxLeft, height: 1, backgroundColor: theme.panel }}>
          <text fg={threadGuideColor} bg={theme.panel}>
            {threadGutterText("continuation")}
          </text>
        </box>
        {showActionOverlay ? (
          renderBottomBorder(savedActionItems)
        ) : (
          <box
            style={{ width: boxWidth, height: 1, backgroundColor: theme.panel }}
            onMouseOver={() => setActionsHovered(true)}
            onMouseOut={() => setActionsHovered(false)}
          >
            <text fg={theme.noteBorder} bg={theme.panel}>
              {`╰${"─".repeat(bottomBorderInnerWidth)}╯`}
            </text>
          </box>
        )}
      </box>
    </box>
  );
}

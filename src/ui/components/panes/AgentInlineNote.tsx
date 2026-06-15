import type { TextareaRenderable } from "@opentui/core";
import {
  createEffect,
  createRenderEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type { AgentAnnotation, DiffFile, LayoutMode } from "../../../core/types";
import { annotationRangeLabel, reviewNoteSource } from "../../lib/agentAnnotations";
import { wrapText } from "../../lib/agentPopover";
import { isEscapeKey, isSaveDraftNoteKey } from "../../lib/keyboard";
import { sanitizeTerminalLine } from "../../../lib/terminalText";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

export function inlineNoteTitle(annotation: AgentAnnotation, noteIndex: number, noteCount: number) {
  if (annotation.source === "user-draft") {
    return "Draft note";
  }

  const source = reviewNoteSource(annotation);
  const author = sanitizeTerminalLine(annotation.author?.trim() ?? "");
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
  return text.split("\n").flatMap((line) => wrapText(sanitizeTerminalLine(line), width));
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
export function AgentInlineNote(props: {
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
  // Element ref kept as a mutable `{ current }` container so `.focus()`/`.blur()` overrides
  // and viewport measurement reads below keep working exactly as before.
  const textareaRef: { current: TextareaRenderable | null } = { current: null };
  const [draftLineCountHint, setDraftLineCountHint] = createSignal(
    draftLineCount(props.draft?.body ?? ""),
  );
  const noteCount = () => props.noteCount ?? 1;
  const noteIndex = () => props.noteIndex ?? 0;

  // Re-sync the line-count hint when the draft body changes externally (auto-tracks props.draft.body).
  createEffect(() => {
    setDraftLineCountHint(draftLineCount(props.draft?.body ?? ""));
  });

  // Was useLayoutEffect([draft]); the focus/blur monkey-patch must run before paint, and it
  // re-installs whenever `props.draft` identity changes. createRenderEffect runs pre-paint and
  // auto-tracks props.draft; onCleanup restores the originals before each re-run / on unmount.
  createRenderEffect(() => {
    const draft = props.draft;
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

    onCleanup(() => {
      active = false;
      textarea.focus = originalFocus;
      textarea.blur = originalBlur;
    });
  });

  // Derived layout/geometry kept as memos so they recompute when props (width/theme/draft) or
  // the draftLineCountHint signal change. In React these were recomputed every render; in Solid
  // the component body runs once, so JSX-feeding derivations must be reactive.
  const closeText = () => (props.onClose ? "[x]" : "");
  const titleText = () =>
    `${inlineNoteTitle(props.annotation, noteIndex(), noteCount())} - ${annotationRangeLabel(props.annotation, props.file)}`;
  const splitWidths = () => splitColumnWidths(props.width);
  const canDockRight = () =>
    props.layout === "split" && props.anchorSide === "new" && props.width >= 84;
  const canDockLeft = () =>
    props.layout === "split" && props.anchorSide === "old" && props.width >= 84;
  const preferredDockWidth = () =>
    canDockRight()
      ? splitWidths().rightWidth
      : canDockLeft()
        ? splitWidths().leftWidth
        : Math.max(34, props.width - 4);
  const boxWidth = () => clamp(preferredDockWidth(), 28, Math.max(28, props.width - 4));
  const boxLeft = () =>
    canDockRight()
      ? Math.max(0, props.width - boxWidth())
      : canDockLeft()
        ? 0
        : Math.min(4, Math.max(0, props.width - boxWidth()));
  const innerWidth = () => Math.max(1, boxWidth() - 2);
  const closeGapWidth = () => (closeText() ? 1 : 0);
  const closeWidth = () => closeText().length;
  const bodyWidth = () => innerWidth();
  const contentWidth = () => Math.max(1, bodyWidth() - 2);
  const draftInnerWidth = () => Math.max(1, boxWidth() - 2);
  const draftContentWidth = () => Math.max(1, draftInnerWidth() - 2);
  const draftVisibleRows = () =>
    props.draft
      ? Math.max(draftLineCountHint(), draftVisualLineCount(props.draft.body, draftContentWidth()))
      : 0;

  // Was useLayoutEffect([draft, draftVisibleRows]); resets the textarea viewport after the
  // composer grows so prior lines stay visible. createRenderEffect runs pre-paint and tracks
  // both props.draft and draftVisibleRows() automatically.
  createRenderEffect(() => {
    const draft = props.draft;
    const visibleRows = draftVisibleRows();
    if (!draft || visibleRows <= 0) {
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const viewport = textarea.editorView.getViewport();
    if (viewport.offsetY === 0 && viewport.height === visibleRows) {
      return;
    }

    // The textarea follows the cursor after Enter while its old one-line viewport is still active.
    // Once the composer grows to fit the new line, reset the viewport so previous lines stay visible.
    textarea.editorView.setViewport(viewport.offsetX, 0, viewport.width, visibleRows, false);
    textarea.requestRender();
  });

  // Was wrapped in flushSync so the React state update committed before the textarea was measured
  // on the next interaction. Solid signal writes apply synchronously, so a plain setter is enough;
  // the dependent draftVisibleRows() memo and the viewport-reset render effect observe the new
  // value on the renderer's next tick.
  const updateDraftLineCountHint = (nextLineCount: number) => {
    setDraftLineCountHint(nextLineCount);
  };

  const lines = (): AgentInlineNoteLine[] => [
    ...wrapNoteText(props.annotation.summary, contentWidth()).map((text) => ({
      kind: "summary" as const,
      text,
    })),
    ...(props.annotation.rationale
      ? wrapNoteText(props.annotation.rationale, contentWidth()).map((text) => ({
          kind: "rationale" as const,
          text,
        }))
      : []),
  ];
  const savedTitleText = () =>
    fitText(` ${titleText()} `, Math.max(0, boxWidth() - 4 - closeGapWidth() - closeWidth()));
  const savedTopBorderSuffixWidth = () =>
    Math.max(0, boxWidth() - 3 - savedTitleText().length - closeGapWidth() - closeWidth());
  const savedTopPrefixWidth = () => 2 + savedTitleText().length + savedTopBorderSuffixWidth();
  const bottomBorder = () => `╰${"─".repeat(Math.max(0, boxWidth() - 2))}╯`;

  const renderDraftBodyPaddingRows = (keyPrefix: string, rowCount: number) =>
    Array.from({ length: rowCount }, () => (
      <box
        style={{
          width: "100%",
          height: 1,
          flexDirection: "row",
          backgroundColor: props.theme.panel,
        }}
      >
        <box style={{ width: boxLeft(), height: 1, backgroundColor: props.theme.panel }}>
          <text>{" ".repeat(boxLeft())}</text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }}>
          <text fg={props.theme.noteBorder} bg={props.theme.panel}>
            │
          </text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }} />
        <box style={{ width: draftContentWidth(), height: 1, backgroundColor: props.theme.panel }}>
          <text bg={props.theme.panel}>{" ".repeat(draftContentWidth())}</text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }} />
        <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }}>
          <text fg={props.theme.noteBorder} bg={props.theme.panel}>
            │
          </text>
        </box>
      </box>
    ));

  return (
    <Show
      when={props.draft}
      fallback={
        <box style={{ width: "100%", flexDirection: "column", backgroundColor: props.theme.panel }}>
          <box
            style={{
              width: "100%",
              height: 1,
              flexDirection: "row",
              backgroundColor: props.theme.panel,
            }}
          >
            <box style={{ width: boxLeft(), height: 1, backgroundColor: props.theme.panel }}>
              <text>{" ".repeat(boxLeft())}</text>
            </box>
            <box
              style={{
                width: savedTopPrefixWidth(),
                height: 1,
                backgroundColor: props.theme.panel,
              }}
            >
              <text>
                <span style={{ fg: props.theme.noteBorder, bg: props.theme.panel }}>╭─</span>
                <span style={{ fg: props.theme.noteTitleText, bg: props.theme.panel }}>
                  {savedTitleText()}
                </span>
                <span style={{ fg: props.theme.noteBorder, bg: props.theme.panel }}>
                  {"─".repeat(savedTopBorderSuffixWidth())}
                </span>
              </text>
            </box>
            <Show when={closeText()}>
              <box
                style={{ width: closeGapWidth(), height: 1, backgroundColor: props.theme.panel }}
              >
                <text bg={props.theme.panel}>{" ".repeat(closeGapWidth())}</text>
              </box>
            </Show>
            <Show when={closeText()}>
              <box
                onMouseUp={props.onClose}
                style={{ width: closeWidth(), height: 1, backgroundColor: props.theme.panel }}
              >
                <text fg={props.theme.noteTitleText} bg={props.theme.panel}>
                  {closeText()}
                </text>
              </box>
            </Show>
            <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }}>
              <text fg={props.theme.noteBorder} bg={props.theme.panel}>
                ╮
              </text>
            </box>
          </box>

          {renderSavedBodyRow("", "summary")}

          <For each={lines()}>{(line) => renderSavedBodyRow(line.text, line.kind)}</For>

          <box
            style={{
              width: "100%",
              height: 1,
              flexDirection: "row",
              backgroundColor: props.theme.panel,
            }}
          >
            <box style={{ width: boxLeft(), height: 1, backgroundColor: props.theme.panel }}>
              <text>{" ".repeat(boxLeft())}</text>
            </box>
            <box style={{ width: boxWidth(), height: 1, backgroundColor: props.theme.panel }}>
              <text fg={props.theme.noteBorder} bg={props.theme.panel}>
                {bottomBorder()}
              </text>
            </box>
          </box>
        </box>
      }
    >
      {(draft) => {
        // Seed the textarea exactly once. `initialValue` must be a static, untracked read: the
        // textarea is the source of truth for its own content, and onContentChange already pushes
        // edits back into the draft signal. Binding it reactively to draft().body would re-seed the
        // editor on every keystroke (write -> re-render -> re-seed -> contentChange -> write...),
        // an infinite loop that ultimately aborts the layout engine.
        const initialBody = untrack(() => draft().body);
        const draftVisibleLineCount = () => draftVisibleRows();
        const draftTitleText = () => fitText(` ${titleText()} `, Math.max(0, boxWidth() - 4));
        const saveInnerWidth = 11;
        const cancelInnerWidth = 14;
        const footerRemainderWidth = () =>
          Math.max(0, boxWidth() - saveInnerWidth - cancelInnerWidth - 4);
        const draftTopBorderSuffix = () =>
          `${"─".repeat(Math.max(0, boxWidth() - 3 - draftTitleText().length))}╮`;
        const footerButtonWidth = () => 1 + saveInnerWidth + 1 + cancelInnerWidth + 1;
        const footerButtonLeft = () => boxLeft() + footerRemainderWidth() + 1;
        const draftActionBorder = () =>
          `╰${"─".repeat(footerRemainderWidth())}┬${"─".repeat(saveInnerWidth)}┬${"─".repeat(cancelInnerWidth)}┤`;
        const draftButtonBottom = `╰${"─".repeat(saveInnerWidth)}┴${"─".repeat(cancelInnerWidth)}╯`;
        const draftTextareaRows = () => draftVisibleLineCount();
        const draftTopPaddingRows = 1;
        const draftBottomPaddingRows = 1;

        return (
          <box
            style={{ width: "100%", flexDirection: "column", backgroundColor: props.theme.panel }}
          >
            <box
              style={{
                width: "100%",
                height: 1,
                flexDirection: "row",
                backgroundColor: props.theme.panel,
              }}
            >
              <box style={{ width: boxLeft(), height: 1, backgroundColor: props.theme.panel }}>
                <text>{" ".repeat(boxLeft())}</text>
              </box>
              <box style={{ width: boxWidth(), height: 1, backgroundColor: props.theme.panel }}>
                <text>
                  <span style={{ fg: props.theme.noteBorder, bg: props.theme.panel }}>╭─</span>
                  <span style={{ fg: props.theme.noteTitleText, bg: props.theme.panel }}>
                    {draftTitleText()}
                  </span>
                  <span style={{ fg: props.theme.noteBorder, bg: props.theme.panel }}>
                    {draftTopBorderSuffix()}
                  </span>
                </text>
              </box>
            </box>

            {renderDraftBodyPaddingRows("draft-body-top-padding", draftTopPaddingRows)}

            <box
              style={{
                width: "100%",
                height: draftTextareaRows(),
                flexDirection: "row",
                backgroundColor: props.theme.panel,
              }}
            >
              <box
                style={{
                  width: boxLeft(),
                  height: draftTextareaRows(),
                  backgroundColor: props.theme.panel,
                }}
              />
              <box
                style={{
                  width: 1,
                  height: draftTextareaRows(),
                  flexDirection: "column",
                  backgroundColor: props.theme.panel,
                }}
              >
                <For each={Array.from({ length: draftTextareaRows() })}>
                  {() => (
                    <text fg={props.theme.noteBorder} bg={props.theme.panel}>
                      │
                    </text>
                  )}
                </For>
              </box>
              <box
                style={{
                  width: 1,
                  height: draftTextareaRows(),
                  backgroundColor: props.theme.panel,
                }}
              />
              <textarea
                ref={(el) => (textareaRef.current = el)}
                width={draftContentWidth()}
                height={draftTextareaRows()}
                initialValue={initialBody}
                placeholder="Write a note…"
                focused={draft().focused}
                backgroundColor={props.theme.panel}
                textColor={props.theme.text}
                focusedBackgroundColor={props.theme.panel}
                focusedTextColor={props.theme.text}
                keyBindings={[{ name: "j", ctrl: true, action: "newline" }]}
                onContentChange={() => {
                  const textarea = textareaRef.current;
                  const nextBody = textarea?.plainText ?? "";
                  updateDraftLineCountHint(
                    Math.max(
                      draftVisualLineCount(nextBody, draftContentWidth()),
                      textarea?.virtualLineCount ?? 0,
                    ),
                  );
                  draft().onInput(nextBody);
                }}
                onKeyDown={(key) => {
                  if (isNewlineKey(key)) {
                    updateDraftLineCountHint(
                      draftVisualLineCount(
                        textareaRef.current?.plainText ?? draft().body,
                        draftContentWidth(),
                      ) + 1,
                    );
                  }

                  if (isSaveDraftNoteKey(key)) {
                    key.preventDefault();
                    key.stopPropagation();
                    draft().onSave();
                    return;
                  }

                  if (isEscapeKey(key)) {
                    key.preventDefault();
                    key.stopPropagation();
                    draft().onCancel();
                  }
                }}
              />
              <box
                style={{
                  width: 1,
                  height: draftTextareaRows(),
                  backgroundColor: props.theme.panel,
                }}
              />
              <box
                style={{
                  width: 1,
                  height: draftTextareaRows(),
                  flexDirection: "column",
                  backgroundColor: props.theme.panel,
                }}
              >
                <For each={Array.from({ length: draftTextareaRows() })}>
                  {() => (
                    <text fg={props.theme.noteBorder} bg={props.theme.panel}>
                      │
                    </text>
                  )}
                </For>
              </box>
            </box>

            {renderDraftBodyPaddingRows("draft-body-bottom-padding", draftBottomPaddingRows)}

            <box
              style={{
                width: "100%",
                height: 1,
                flexDirection: "row",
                backgroundColor: props.theme.panel,
              }}
            >
              <box style={{ width: boxLeft(), height: 1, backgroundColor: props.theme.panel }}>
                <text>{" ".repeat(boxLeft())}</text>
              </box>
              <box style={{ width: boxWidth(), height: 1, backgroundColor: props.theme.panel }}>
                <text fg={props.theme.noteBorder} bg={props.theme.panel}>
                  {draftActionBorder()}
                </text>
              </box>
            </box>

            <box
              style={{
                width: "100%",
                height: 1,
                flexDirection: "row",
                backgroundColor: props.theme.panel,
              }}
            >
              <box
                style={{ width: footerButtonLeft(), height: 1, backgroundColor: props.theme.panel }}
              >
                <text>{" ".repeat(footerButtonLeft())}</text>
              </box>
              <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }}>
                <text fg={props.theme.noteBorder} bg={props.theme.panel}>
                  │
                </text>
              </box>
              <box onMouseUp={draft().onSave} style={{ width: saveInnerWidth, height: 1 }}>
                <text fg={props.theme.noteTitleText} bg={props.theme.panel}>
                  {padText(" Save (^S) ", saveInnerWidth)}
                </text>
              </box>
              <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }}>
                <text fg={props.theme.noteBorder} bg={props.theme.panel}>
                  │
                </text>
              </box>
              <box onMouseUp={draft().onCancel} style={{ width: cancelInnerWidth, height: 1 }}>
                <text fg={props.theme.noteTitleText} bg={props.theme.panel}>
                  {padText(" Cancel (Esc) ", cancelInnerWidth)}
                </text>
              </box>
              <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }}>
                <text fg={props.theme.noteBorder} bg={props.theme.panel}>
                  │
                </text>
              </box>
            </box>

            <box
              style={{
                width: "100%",
                height: 1,
                flexDirection: "row",
                backgroundColor: props.theme.panel,
              }}
            >
              <box
                style={{ width: footerButtonLeft(), height: 1, backgroundColor: props.theme.panel }}
              >
                <text>{" ".repeat(footerButtonLeft())}</text>
              </box>
              <box
                style={{
                  width: footerButtonWidth(),
                  height: 1,
                  backgroundColor: props.theme.panel,
                }}
              >
                <text fg={props.theme.noteBorder} bg={props.theme.panel}>
                  {draftButtonBottom}
                </text>
              </box>
            </box>
          </box>
        );
      }}
    </Show>
  );

  /** Render one body row inside the saved (non-draft) note card. */
  function renderSavedBodyRow(text: string, kind: AgentInlineNoteLine["kind"]) {
    return (
      <box
        style={{
          width: "100%",
          height: 1,
          flexDirection: "row",
          backgroundColor: props.theme.panel,
        }}
      >
        <box style={{ width: boxLeft(), height: 1, backgroundColor: props.theme.panel }}>
          <text>{" ".repeat(boxLeft())}</text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }}>
          <text fg={props.theme.noteBorder} bg={props.theme.panel}>
            │
          </text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }} />
        <box style={{ width: contentWidth(), height: 1, backgroundColor: props.theme.panel }}>
          <text
            fg={kind === "summary" ? props.theme.text : props.theme.muted}
            bg={props.theme.panel}
          >
            {padText(text, contentWidth())}
          </text>
        </box>
        <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }} />
        <box style={{ width: 1, height: 1, backgroundColor: props.theme.panel }}>
          <text fg={props.theme.noteBorder} bg={props.theme.panel}>
            │
          </text>
        </box>
      </box>
    );
  }
}

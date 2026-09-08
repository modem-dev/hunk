import { parseColor, StyledText, TextAttributes, type TextChunk } from "@opentui/core";
import { Component, memo, useMemo, type ReactNode } from "react";
import type { DiffFile } from "../../../core/changeset/model";
import type {
  ExtensionFileViewLayout,
  ExtensionFileViewRow,
  ExtensionFileViewRowComponentProps,
  ExtensionFileViewSpan,
} from "../../../extension-api/types";
import type { AppTheme } from "../../themes";
import type { DiffSectionGeometry } from "../../diff/diffSectionGeometry";
import { plannedRowMatchesCursor, type CursorHighlight } from "../../diff/cursorHighlight";
import { cursorLineHighlightBg } from "../../diff/rowStyle";
import { resolveVisibleRowIndexWindow, type VisibleBodyBounds } from "../../diff/rowWindowing";
import { reviewRowId } from "../../lib/ids";
import { toExtensionPaintTheme } from "../../lib/extensionPaintTheme";
import type { PlannedFileViewRow } from "../../fileViews/renderPlan";
import { preserveCrossSpanGraphemes } from "../../diff/styledSpanLayout";
import {
  createFileViewSyntaxProjector,
  type FileViewSyntaxProjector,
} from "../../fileViews/syntaxPaint";
import type { FileViewRowFailure } from "../../fileViews/types";
import { useFileViewSyntaxHighlight } from "../../fileViews/useFileViewSyntaxHighlight";
import type { ResolvedFileViewLayout } from "../../fileViews/useFileViews";
import { AgentInlineNote } from "./AgentInlineNote";

type FileViewTone = ExtensionFileViewSpan["tone"];
type FileViewTextAttribute = NonNullable<ExtensionFileViewSpan["attributes"]>[number];

/** Resolve a generic file-view tone only at paint time, keeping layout theme-independent. */
function fileViewToneColor(tone: FileViewTone, theme: AppTheme) {
  switch (tone) {
    case "muted":
      return theme.muted;
    case "accent":
      return theme.accent;
    case "accent-muted":
      return theme.accentMuted;
    case "syntax":
      return theme.syntaxColors.default;
    case "added":
      return theme.fileNew;
    case "removed":
      return theme.fileDeleted;
    default:
      return theme.text;
  }
}

const FILE_VIEW_ATTRIBUTE_BITS: Record<FileViewTextAttribute, number> = {
  bold: TextAttributes.BOLD,
  italic: TextAttributes.ITALIC,
  underline: TextAttributes.UNDERLINE,
  strikethrough: TextAttributes.STRIKETHROUGH,
};

/** Combine generic emphasis attributes into OpenTUI's terminal bitmask. */
function fileViewTextAttributes(attributes: readonly FileViewTextAttribute[] | undefined) {
  return (attributes ?? []).reduce(
    (combined, attribute) => combined | FILE_VIEW_ATTRIBUTE_BITS[attribute],
    TextAttributes.NONE,
  );
}

/** Report whether one symbolic row belongs to the currently selected hunk. */
export function isFileViewRowSelected(
  layout: ExtensionFileViewLayout,
  rowIndex: number,
  selectedHunkIndex: number,
) {
  const selectedHunk = layout.hunkRows[selectedHunkIndex];
  return Boolean(
    selectedHunk && rowIndex >= selectedHunk.startRow && rowIndex <= selectedHunk.endRow,
  );
}

const fileViewPaintColorCache = new Map<string, ReturnType<typeof parseColor>>();

/** Parse one host-owned paint color while reusing immutable terminal color values. */
function fileViewPaintColor(value: string) {
  let parsed = fileViewPaintColorCache.get(value);
  if (!parsed) {
    parsed = parseColor(value);
    fileViewPaintColorCache.set(value, parsed);
  }
  return parsed;
}

/** Paint one row through the symbolic host-rendered path, adding syntax foregrounds only. */
function SymbolicFileViewRow({
  projector,
  row,
  theme,
}: {
  projector: FileViewSyntaxProjector;
  row: ExtensionFileViewRow;
  theme: AppTheme;
}) {
  const content = useMemo(() => {
    const paintRuns: Array<{ text: string; fg: string; attributes: number }> = [];
    for (const span of row.spans) {
      const fallbackForeground = fileViewToneColor(span.tone, theme);
      const attributes = fileViewTextAttributes(span.attributes);
      const syntaxRuns = projector.projectSpan(span);
      for (const run of syntaxRuns ?? [{ text: span.text }]) {
        paintRuns.push({
          text: run.text,
          fg: run.fg ?? fallbackForeground,
          attributes,
        });
      }
    }
    // Resolve graphemes once across the complete authored row. Retained tabs pass through so
    // OpenTUI paints each as the same indivisible two-cell unit used by geometry measurement.
    const displayRuns = preserveCrossSpanGraphemes(paintRuns);
    const chunks: TextChunk[] = displayRuns.map((run) => ({
      __isChunk: true,
      text: run.text,
      fg: fileViewPaintColor(run.fg),
      attributes: run.attributes,
    }));
    return new StyledText(chunks);
  }, [projector, row.spans, theme]);
  return <text content={content} wrapMode="word" />;
}

/** Contain synchronous render/lifecycle failures to one row and attribute them to the host. */
class FileViewRowErrorBoundary extends Component<
  {
    children: ReactNode;
    fallback: ReactNode;
    onError: (error: unknown) => void;
  },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Render host-windowed symbolic and custom rows without surrendering outer geometry. */
function FileViewComponent({
  file,
  fileView,
  geometry,
  cursorHighlight,
  offloadLargeDiff = false,
  selectedHunkIndex,
  shouldLoadHighlight = false,
  theme,
  visibleBodyBounds,
  width,
  onRowFailure,
}: {
  file: DiffFile;
  fileView: ResolvedFileViewLayout;
  geometry: DiffSectionGeometry;
  /** The current line within this file, when the review-stream cursor rests in it. */
  cursorHighlight?: CursorHighlight;
  offloadLargeDiff?: boolean;
  selectedHunkIndex: number;
  shouldLoadHighlight?: boolean;
  theme: AppTheme;
  visibleBodyBounds?: VisibleBodyBounds;
  width: number;
  onRowFailure?: (failure: FileViewRowFailure) => void;
}) {
  const { layout } = fileView;
  const publicTheme = useMemo(() => toExtensionPaintTheme(theme), [theme]);
  const plannedRows: readonly PlannedFileViewRow[] = useMemo(
    () =>
      geometry.fileViewRows ??
      layout.rows.map((row, rowIndex) => ({
        kind: "file-view-row" as const,
        key: `file-view:${row.id}`,
        stableKey: `file-view:${row.id}`,
        row,
        rowIndex,
      })),
    [geometry.fileViewRows, layout.rows],
  );
  const rowWindow = useMemo(() => {
    if (!visibleBodyBounds) {
      return {
        bottomSpacerHeight: 0,
        endIndex: plannedRows.length,
        startIndex: 0,
        topSpacerHeight: 0,
      };
    }
    return resolveVisibleRowIndexWindow({
      bodyHeight: geometry.bodyHeight,
      rowBounds: geometry.rowBounds,
      visibleBodyBounds,
    });
  }, [geometry.bodyHeight, geometry.rowBounds, plannedRows.length, visibleBodyBounds]);

  const mountedRows = useMemo(
    () => plannedRows.slice(rowWindow.startIndex, rowWindow.endIndex),
    [plannedRows, rowWindow.endIndex, rowWindow.startIndex],
  );
  // Demand follows the host row window so inserted notes and offscreen extension rows add no work.
  const syntaxHighlights = useFileViewSyntaxHighlight({
    file,
    fileView,
    mountedRows,
    offloadLargeDiff,
    shouldLoadHighlight,
    theme,
  });
  const syntaxProjector = useMemo(
    () => createFileViewSyntaxProjector(syntaxHighlights),
    [syntaxHighlights],
  );
  return (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {rowWindow.topSpacerHeight > 0 ? (
        <box style={{ width: "100%", height: rowWindow.topSpacerHeight }} />
      ) : null}
      {mountedRows.map((plannedRow) => {
        if (plannedRow.kind === "inline-note") {
          return (
            <box
              key={plannedRow.key}
              id={reviewRowId(plannedRow.key)}
              style={{ width: "100%", flexDirection: "column" }}
            >
              <AgentInlineNote
                annotation={plannedRow.annotation}
                active={plannedRow.note.active}
                actionKeyLabels={plannedRow.note.actionKeyLabels}
                anchorSide={plannedRow.anchorSide}
                file={file}
                layout="unified"
                noteCount={plannedRow.noteCount}
                noteIndex={plannedRow.noteIndex}
                draft={plannedRow.note.draft}
                actions={plannedRow.note.actions}
                onActivate={plannedRow.note.onActivate}
                thread={plannedRow.note.thread}
                theme={theme}
                width={width}
              />
            </box>
          );
        }

        const row = plannedRow.row;
        const index = plannedRow.rowIndex;
        const selected = isFileViewRowSelected(layout, index, selectedHunkIndex);
        const onCursorRow = plannedRowMatchesCursor(plannedRow, cursorHighlight);
        const rowBackground = selected ? theme.selectedHunk : theme.panel;
        const fixedHeight = row.component?.height;
        const View = row.component?.render as
          | ((props: ExtensionFileViewRowComponentProps) => ReactNode)
          | undefined;
        const fallback = (
          <SymbolicFileViewRow projector={syntaxProjector} row={row} theme={theme} />
        );
        // Selection is deliberately absent: hook state survives ordinary selected-prop updates.
        // Window unmount or any accepted layout/registration generation creates a fresh identity.
        const paintIdentity = `${file.id}:${fileView.registrationIdentity}:${fileView.layoutGeneration}:${row.id}`;
        return (
          <box
            key={paintIdentity}
            id={reviewRowId(`file-view:${row.id}`)}
            style={{
              width: "100%",
              ...(fixedHeight === undefined
                ? {}
                : {
                    height: fixedHeight,
                    minHeight: fixedHeight,
                    maxHeight: fixedHeight,
                    flexShrink: 0,
                    overflow: "hidden" as const,
                  }),
              flexDirection: "row",
              // Presentation rows carry no line-number column, so both marker styles paint a band.
              backgroundColor: onCursorRow
                ? cursorLineHighlightBg(rowBackground, theme)
                : rowBackground,
            }}
          >
            {View && fixedHeight !== undefined ? (
              <FileViewRowErrorBoundary
                fallback={fallback}
                onError={(error) =>
                  onRowFailure?.({
                    extensionId: fileView.extensionId,
                    viewId: fileView.viewId,
                    fileId: file.id,
                    filePath: file.path,
                    rowId: row.id,
                    layoutGeneration: fileView.layoutGeneration,
                    message: error instanceof Error ? error.message || error.name : String(error),
                  })
                }
              >
                <box
                  style={{
                    width: "100%",
                    height: fixedHeight,
                    minHeight: fixedHeight,
                    maxHeight: fixedHeight,
                    flexShrink: 0,
                    overflow: "hidden",
                  }}
                >
                  <View
                    width={Math.max(1, Math.floor(width))}
                    height={fixedHeight}
                    selected={selected}
                    rowIndex={index}
                    theme={publicTheme}
                  />
                </box>
              </FileViewRowErrorBoundary>
            ) : (
              fallback
            )}
          </box>
        );
      })}
      {rowWindow.bottomSpacerHeight > 0 ? (
        <box style={{ width: "100%", height: rowWindow.bottomSpacerHeight }} />
      ) : null}
    </box>
  );
}

export const FileView = memo(FileViewComponent);

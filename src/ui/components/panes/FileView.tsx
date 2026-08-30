import { TextAttributes } from "@opentui/core";
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
import type { FileViewRowFailure } from "../../fileViews/types";
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

/** Paint one row through the original symbolic host-rendered path. */
function SymbolicFileViewRow({ row, theme }: { row: ExtensionFileViewRow; theme: AppTheme }) {
  return row.spans.map((span, spanIndex) => (
    <text
      key={`${row.id}:${spanIndex}`}
      fg={fileViewToneColor(span.tone, theme)}
      attributes={fileViewTextAttributes(span.attributes)}
    >
      {span.text}
    </text>
  ));
}

/** Contain synchronous render/lifecycle failures to one row and attribute them to the host. */
class FileViewRowErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onError: (error: unknown) => void },
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
  selectedHunkIndex,
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
  selectedHunkIndex: number;
  theme: AppTheme;
  visibleBodyBounds?: VisibleBodyBounds;
  width: number;
  onRowFailure?: (failure: FileViewRowFailure) => void;
}) {
  const { layout } = fileView;
  const publicTheme = useMemo(() => toExtensionPaintTheme(theme), [theme]);
  const plannedRows: readonly PlannedFileViewRow[] =
    geometry.fileViewRows ??
    layout.rows.map((row, rowIndex) => ({
      kind: "file-view-row" as const,
      key: `file-view:${row.id}`,
      stableKey: `file-view:${row.id}`,
      row,
      rowIndex,
    }));
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

  const mountedRows = plannedRows.slice(rowWindow.startIndex, rowWindow.endIndex);
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
                anchorSide={plannedRow.anchorSide}
                file={file}
                layout="stack"
                noteCount={plannedRow.noteCount}
                noteIndex={plannedRow.noteIndex}
                draft={plannedRow.note.draft}
                actions={plannedRow.note.actions}
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
        const fallback = <SymbolicFileViewRow row={row} theme={theme} />;
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

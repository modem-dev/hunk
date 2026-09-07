import { useMemo } from "react";
import { DEFAULT_HUNK_GAP } from "../core/run/reviewGap";
import { DEFAULT_TAB_WIDTH } from "../core/run/tabWidth";
import { findMaxLineNumber } from "../ui/diff/codeColumns";
import { buildSplitRows, buildStackRows } from "../ui/diff/diffRows";
import { DiffRowView } from "../ui/diff/DiffRowView";
import { diffMessage, fitText } from "../ui/diff/plannedRowText";
import { buildReviewRenderPlan } from "../ui/diff/reviewRenderPlan";
import { plannedReviewRowVisible } from "../ui/diff/reviewRowGeometry";
import { useHighlightedDiff } from "../ui/diff/useHighlightedDiff";
import { reviewRowId } from "../ui/lib/ids";
import { resolveTheme } from "../ui/themes";
import { toInternalDiffFile } from "./model";
import type { HunkDiffBodyProps } from "./types";

/** Render one diff file body without owning navigation, app chrome, or global shortcuts. */
export function HunkDiffBody({
  file,
  layout = "split",
  width,
  theme = "github-dark-default",
  showLineNumbers = true,
  showHunkHeaders = true,
  tabWidth = DEFAULT_TAB_WIDTH,
  hunkGap = DEFAULT_HUNK_GAP,
  wrapLines = false,
  horizontalOffset = 0,
  highlight = true,
  selectedHunkIndex = 0,
}: HunkDiffBodyProps) {
  const resolvedTheme = resolveTheme(theme, null);
  const internalFile = useMemo(() => (file ? toInternalDiffFile(file) : undefined), [file]);
  const resolvedHighlighted = useHighlightedDiff({
    file: internalFile,
    theme: resolvedTheme,
    shouldLoadHighlight: highlight,
  });
  const rows = useMemo(
    () =>
      internalFile
        ? layout === "split"
          ? buildSplitRows(internalFile, resolvedHighlighted, resolvedTheme, tabWidth)
          : buildStackRows(internalFile, resolvedHighlighted, resolvedTheme, tabWidth)
        : [],
    [internalFile, layout, resolvedHighlighted, resolvedTheme, tabWidth],
  );
  const plannedRows = useMemo(
    () =>
      internalFile
        ? buildReviewRenderPlan({
            fileId: internalFile.id,
            rows,
            showHunkHeaders,
            hunkGap,
          })
        : [],
    [hunkGap, internalFile, rows, showHunkHeaders],
  );
  const lineNumberDigits = useMemo(
    () => String(internalFile ? findMaxLineNumber(internalFile) : 1).length,
    [internalFile],
  );

  if (!internalFile) {
    return (
      <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1 }}>
        <text fg={resolvedTheme.muted}>{fitText("No file selected.", Math.max(1, width - 2))}</text>
      </box>
    );
  }

  if (internalFile.metadata.hunks.length === 0) {
    return (
      <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1, paddingBottom: 1 }}>
        <text fg={resolvedTheme.muted}>
          {fitText(diffMessage(internalFile), Math.max(1, width - 2))}
        </text>
      </box>
    );
  }

  return (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {plannedRows.map((plannedRow) => {
        if (
          !plannedReviewRowVisible(plannedRow, {
            layout,
            showHunkHeaders,
            width,
          })
        ) {
          return null;
        }

        if (plannedRow.kind === "hunk-gap") {
          return (
            <box
              key={plannedRow.key}
              id={reviewRowId(plannedRow.key)}
              style={{
                width: "100%",
                height: plannedRow.height,
                backgroundColor: resolvedTheme.panel,
              }}
            />
          );
        }

        if (plannedRow.kind !== "diff-row") {
          return null;
        }

        return (
          <box
            key={plannedRow.key}
            id={reviewRowId(plannedRow.key)}
            style={{ width: "100%", flexDirection: "column" }}
          >
            <DiffRowView
              plannedRow={plannedRow}
              width={width}
              lineNumberDigits={lineNumberDigits}
              showLineNumbers={showLineNumbers}
              showHunkHeaders={showHunkHeaders}
              wrapLines={wrapLines}
              codeHorizontalOffset={horizontalOffset}
              theme={resolvedTheme}
              selected={plannedRow.row.hunkIndex === selectedHunkIndex}
            />
          </box>
        );
      })}
    </box>
  );
}

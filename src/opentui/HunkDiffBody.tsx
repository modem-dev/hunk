import { useMemo } from "react";
import { findMaxLineNumber } from "../ui/diff/codeColumns";
import { buildSplitRows, buildStackRows } from "../ui/diff/pierre";
import { diffMessage, DiffRowView, fitText } from "../ui/diff/renderRows";
import { useHighlightedDiff } from "../ui/diff/useHighlightedDiff";
import { resolveTheme } from "../ui/themes";
import { toInternalDiffFile } from "./model";
import type { HunkDiffBodyProps } from "./types";

const EMPTY_ANNOTATED_HUNK_INDICES = new Set<number>();

/** Render one diff file body without owning navigation, app chrome, or global shortcuts. */
export function HunkDiffBody({
  file,
  layout = "split",
  width,
  theme = "graphite",
  showLineNumbers = true,
  showHunkHeaders = true,
  wrapLines = false,
  horizontalOffset = 0,
  highlight = true,
  selectedHunkIndex = 0,
}: HunkDiffBodyProps) {
  const resolvedTheme = resolveTheme(theme, null);
  const internalFile = useMemo(() => (file ? toInternalDiffFile(file) : undefined), [file]);
  const resolvedHighlighted = useHighlightedDiff({
    file: internalFile,
    appearance: resolvedTheme.appearance,
    shouldLoadHighlight: highlight,
  });
  const rows = useMemo(
    () =>
      internalFile
        ? layout === "split"
          ? buildSplitRows(internalFile, resolvedHighlighted, resolvedTheme)
          : buildStackRows(internalFile, resolvedHighlighted, resolvedTheme)
        : [],
    [internalFile, layout, resolvedHighlighted, resolvedTheme],
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
      {rows.map((row) => (
        <box key={row.key} style={{ width: "100%", flexDirection: "column" }}>
          <DiffRowView
            row={row}
            width={width}
            lineNumberDigits={lineNumberDigits}
            showLineNumbers={showLineNumbers}
            showHunkHeaders={showHunkHeaders}
            wrapLines={wrapLines}
            codeHorizontalOffset={horizontalOffset}
            theme={resolvedTheme}
            selected={row.hunkIndex === selectedHunkIndex}
            annotated={EMPTY_ANNOTATED_HUNK_INDICES.has(row.hunkIndex)}
          />
        </box>
      ))}
    </box>
  );
}

import { resolveTheme } from "../ui/themes";
import { HunkDiffBody } from "./HunkDiffBody";
import { HunkDiffFileHeader } from "./HunkDiffFileHeader";
import type { HunkDiffFileInput, HunkDiffSelection, HunkReviewStreamProps } from "./types";

/** Resolve the active selection, defaulting to the first file and first hunk. */
function resolveSelection(files: HunkDiffFileInput[], selection: HunkDiffSelection | undefined) {
  if (selection && files.some((file) => file.id === selection.fileId)) {
    return selection;
  }

  const first = files[0];
  return first ? { fileId: first.id, hunkIndex: 0 } : undefined;
}

/** Render a top-to-bottom multi-file review stream without Hunk's app shell, keybindings, or scrolling. */
export function HunkReviewStream({
  files,
  layout = "split",
  width,
  theme = "graphite",
  selection,
  showFileHeaders = true,
  showFileSeparators = true,
  showLineNumbers = true,
  showHunkHeaders = true,
  wrapLines = false,
  horizontalOffset = 0,
  highlight = true,
  onSelectionChange,
}: HunkReviewStreamProps) {
  const resolvedTheme = resolveTheme(theme, null);
  const activeSelection = resolveSelection(files, selection);

  if (files.length === 0) {
    return (
      <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1 }}>
        <text fg={resolvedTheme.muted}>No files to render.</text>
      </box>
    );
  }

  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: resolvedTheme.panel }}>
      {files.map((file, index) => {
        const selectedHunkIndex =
          activeSelection?.fileId === file.id ? activeSelection.hunkIndex : -1;

        return (
          <box
            key={file.id}
            style={{
              width: "100%",
              flexDirection: "column",
              backgroundColor: resolvedTheme.panel,
            }}
          >
            {showFileSeparators && index > 0 ? (
              <box style={{ width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 }}>
                <text fg={resolvedTheme.border}>{"─".repeat(Math.max(1, width - 2))}</text>
              </box>
            ) : null}
            {showFileHeaders ? (
              <HunkDiffFileHeader
                file={file}
                width={width}
                theme={theme}
                onSelect={() => onSelectionChange?.({ fileId: file.id, hunkIndex: 0 })}
              />
            ) : null}
            <HunkDiffBody
              file={file}
              layout={layout}
              width={width}
              theme={theme}
              showLineNumbers={showLineNumbers}
              showHunkHeaders={showHunkHeaders}
              wrapLines={wrapLines}
              horizontalOffset={horizontalOffset}
              highlight={highlight}
              selectedHunkIndex={selectedHunkIndex}
            />
          </box>
        );
      })}
    </box>
  );
}

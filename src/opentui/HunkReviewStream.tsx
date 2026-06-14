import { createMemo, For, mergeProps, Show } from "solid-js";
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
export function HunkReviewStream(props: HunkReviewStreamProps) {
  const merged = mergeProps(
    {
      layout: "split" as const,
      theme: "graphite" as const,
      showFileHeaders: true,
      showFileSeparators: true,
      showLineNumbers: true,
      showHunkHeaders: true,
      wrapLines: false,
      horizontalOffset: 0,
      highlight: true,
    },
    props,
  );
  const resolvedTheme = createMemo(() => resolveTheme(merged.theme, null));
  const activeSelection = createMemo(() => resolveSelection(merged.files, merged.selection));

  return (
    <Show
      when={merged.files.length > 0}
      fallback={
        <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1 }}>
          <text fg={resolvedTheme().muted}>No files to render.</text>
        </box>
      }
    >
      <box
        style={{ width: "100%", flexDirection: "column", backgroundColor: resolvedTheme().panel }}
      >
        <For each={merged.files}>
          {(file, index) => {
            const selectedHunkIndex = createMemo(() => {
              const selection = activeSelection();
              return selection?.fileId === file.id ? selection.hunkIndex : -1;
            });

            return (
              <box
                style={{
                  width: "100%",
                  flexDirection: "column",
                  backgroundColor: resolvedTheme().panel,
                }}
              >
                <Show when={merged.showFileSeparators && index() > 0}>
                  <box style={{ width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 }}>
                    <text fg={resolvedTheme().border}>
                      {"─".repeat(Math.max(1, merged.width - 2))}
                    </text>
                  </box>
                </Show>
                <Show when={merged.showFileHeaders}>
                  <HunkDiffFileHeader
                    file={file}
                    width={merged.width}
                    theme={merged.theme}
                    onSelect={() => merged.onSelectionChange?.({ fileId: file.id, hunkIndex: 0 })}
                  />
                </Show>
                <HunkDiffBody
                  file={file}
                  layout={merged.layout}
                  width={merged.width}
                  theme={merged.theme}
                  showLineNumbers={merged.showLineNumbers}
                  showHunkHeaders={merged.showHunkHeaders}
                  wrapLines={merged.wrapLines}
                  horizontalOffset={merged.horizontalOffset}
                  highlight={merged.highlight}
                  selectedHunkIndex={selectedHunkIndex()}
                />
              </box>
            );
          }}
        </For>
      </box>
    </Show>
  );
}

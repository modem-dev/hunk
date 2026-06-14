import { createMemo, For, mergeProps, Show } from "solid-js";
import { findMaxLineNumber } from "../ui/diff/codeColumns";
import { buildSplitRows, buildStackRows } from "../ui/diff/pierre";
import { diffMessage, DiffRowView, fitText } from "../ui/diff/renderRows";
import { useHighlightedDiff } from "../ui/diff/useHighlightedDiff";
import { resolveTheme } from "../ui/themes";
import { toInternalDiffFile } from "./model";
import type { HunkDiffBodyProps } from "./types";

/** Render one diff file body without owning navigation, app chrome, or global shortcuts. */
export function HunkDiffBody(props: HunkDiffBodyProps) {
  const merged = mergeProps(
    {
      layout: "split" as const,
      theme: "graphite" as const,
      showLineNumbers: true,
      showHunkHeaders: true,
      wrapLines: false,
      horizontalOffset: 0,
      highlight: true,
      selectedHunkIndex: 0,
    },
    props,
  );
  const resolvedTheme = createMemo(() => resolveTheme(merged.theme, null));
  const internalFile = createMemo(() =>
    merged.file ? toInternalDiffFile(merged.file) : undefined,
  );
  const resolvedHighlighted = useHighlightedDiff({
    file: internalFile,
    appearance: () => resolvedTheme().appearance,
    shouldLoadHighlight: () => merged.highlight,
  });
  const rows = createMemo(() => {
    const file = internalFile();
    if (!file) {
      return [];
    }
    return merged.layout === "split"
      ? buildSplitRows(file, resolvedHighlighted(), resolvedTheme())
      : buildStackRows(file, resolvedHighlighted(), resolvedTheme());
  });
  const lineNumberDigits = createMemo(() => {
    const file = internalFile();
    return String(file ? findMaxLineNumber(file) : 1).length;
  });

  return (
    <Show
      when={internalFile()}
      fallback={
        <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1 }}>
          <text fg={resolvedTheme().muted}>
            {fitText("No file selected.", Math.max(1, merged.width - 2))}
          </text>
        </box>
      }
    >
      {(file) => (
        <Show
          when={file().metadata.hunks.length > 0}
          fallback={
            <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1, paddingBottom: 1 }}>
              <text fg={resolvedTheme().muted}>
                {fitText(diffMessage(file()), Math.max(1, merged.width - 2))}
              </text>
            </box>
          }
        >
          <box style={{ width: "100%", flexDirection: "column" }}>
            <For each={rows()}>
              {(row) => (
                <box style={{ width: "100%", flexDirection: "column" }}>
                  <DiffRowView
                    row={row}
                    width={merged.width}
                    lineNumberDigits={lineNumberDigits()}
                    showLineNumbers={merged.showLineNumbers}
                    showHunkHeaders={merged.showHunkHeaders}
                    wrapLines={merged.wrapLines}
                    codeHorizontalOffset={merged.horizontalOffset}
                    theme={resolvedTheme()}
                    selected={row.hunkIndex === merged.selectedHunkIndex}
                  />
                </box>
              )}
            </For>
          </box>
        </Show>
      )}
    </Show>
  );
}

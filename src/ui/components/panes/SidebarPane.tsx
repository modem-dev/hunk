import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, Match, mergeProps, Switch } from "solid-js";
import { sidebarEntryStatsWidth, type SidebarEntry } from "../../lib/files";
import { buildSidebarRenderWindow } from "../../lib/sidebarRenderWindow";
import type { AppTheme } from "../../themes";
import { FileGroupHeader, FileListItem } from "./FileListItem";

/** Render the file navigation sidebar. */
export function SidebarPane(props: {
  entries: SidebarEntry[];
  scrollRef: { current: ScrollBoxRenderable | null };
  selectedFileId?: string;
  textWidth: number;
  theme: AppTheme;
  width: number;
  estimatedViewportRows?: number;
  onSelectFile: (fileId: string) => void;
}) {
  const merged = mergeProps({ estimatedViewportRows: 32 }, props);
  const [scrollViewport, setScrollViewport] = createSignal({ top: 0, height: 0 });
  const fileEntries = () => merged.entries.filter((entry) => entry.kind === "file");
  const statsWidth = () =>
    Math.max(0, ...fileEntries().map((entry) => sidebarEntryStatsWidth(entry)));
  const renderWindow = createMemo(() =>
    buildSidebarRenderWindow({
      entries: merged.entries,
      estimatedViewportRows: merged.estimatedViewportRows,
      overscanRows: 4,
      scrollTop: scrollViewport().top,
      selectedFileId: merged.selectedFileId,
      viewportHeight: scrollViewport().height,
    }),
  );

  // Bind viewport listeners to the live scrollbox and re-bind when the entry count
  // or scroll ref changes (matches the old [entries.length, scrollRef] deps).
  createEffect(() => {
    // Track the dependencies that should force a re-bind.
    void merged.entries.length;
    const scrollBox = merged.scrollRef.current;
    if (!scrollBox) {
      return;
    }

    let cancelled = false;
    let scheduled = false;

    const readViewport = () => {
      const nextTop = scrollBox.scrollTop ?? 0;
      const nextHeight = scrollBox.viewport.height ?? 0;
      setScrollViewport((current) =>
        current.top === nextTop && current.height === nextHeight
          ? current
          : { top: nextTop, height: nextHeight },
      );
    };

    const handleViewportChange = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        if (cancelled) {
          scheduled = false;
          return;
        }

        try {
          readViewport();
        } finally {
          scheduled = false;
        }
      });
    };

    readViewport();
    scrollBox.verticalScrollBar.on("change", handleViewportChange);
    scrollBox.viewport.on("layout-changed", handleViewportChange);
    scrollBox.viewport.on("resized", handleViewportChange);

    return () => {
      cancelled = true;
      scrollBox.verticalScrollBar.off("change", handleViewportChange);
      scrollBox.viewport.off("layout-changed", handleViewportChange);
      scrollBox.viewport.off("resized", handleViewportChange);
    };
  });

  return (
    <box
      style={{
        width: merged.width,
        border: ["top"],
        borderColor: merged.theme.border,
        backgroundColor: merged.theme.panel,
        paddingY: 1,
        paddingX: 0,
        flexDirection: "column",
      }}
    >
      <scrollbox
        ref={(el) => (merged.scrollRef.current = el)}
        width="100%"
        height="100%"
        focused={false}
        scrollY={true}
        viewportCulling={true}
        rootOptions={{ backgroundColor: merged.theme.panel }}
        wrapperOptions={{ backgroundColor: merged.theme.panel }}
        viewportOptions={{ backgroundColor: merged.theme.panel }}
        contentOptions={{ backgroundColor: merged.theme.panel }}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <box style={{ width: "100%", flexDirection: "column" }}>
          <For each={renderWindow().items}>
            {(item) => (
              <Switch>
                <Match when={item.kind === "spacer" ? item : null}>
                  {(spacer) => (
                    <box
                      style={{
                        width: "100%",
                        height: spacer().height,
                        backgroundColor: merged.theme.panel,
                      }}
                    />
                  )}
                </Match>
                <Match
                  when={item.kind === "entry" && item.entry.kind === "group" ? item.entry : null}
                >
                  {(entry) => (
                    <FileGroupHeader
                      entry={entry()}
                      textWidth={merged.textWidth}
                      theme={merged.theme}
                    />
                  )}
                </Match>
                <Match
                  when={item.kind === "entry" && item.entry.kind === "file" ? item.entry : null}
                >
                  {(entry) => (
                    <FileListItem
                      entry={entry()}
                      selected={entry().id === merged.selectedFileId}
                      statsWidth={statsWidth()}
                      textWidth={merged.textWidth}
                      theme={merged.theme}
                      onSelectFile={merged.onSelectFile}
                    />
                  )}
                </Match>
              </Switch>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  );
}

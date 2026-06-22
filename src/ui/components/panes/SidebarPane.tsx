import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { sidebarEntryStatsWidth, type SidebarEntry } from "../../lib/files";
import { buildSidebarRenderWindow } from "../../lib/sidebarRenderWindow";
import type { AppTheme } from "../../themes";
import { FileGroupHeader, FileListItem } from "./FileListItem";

/** Render the file navigation sidebar. */
export function SidebarPane({
  entries,
  scrollRef,
  selectedFileId,
  nerdFontIcons = false,
  textWidth,
  theme,
  width,
  estimatedViewportRows = 32,
  onSelectFile,
}: {
  entries: SidebarEntry[];
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  selectedFileId?: string;
  nerdFontIcons?: boolean;
  textWidth: number;
  theme: AppTheme;
  width: number;
  estimatedViewportRows?: number;
  onSelectFile: (fileId: string) => void;
}) {
  const [scrollViewport, setScrollViewport] = useState({ top: 0, height: 0 });
  const fileEntries = entries.filter((entry) => entry.kind === "file");
  const statsWidth = Math.max(0, ...fileEntries.map((entry) => sidebarEntryStatsWidth(entry)));
  const renderWindow = useMemo(
    () =>
      buildSidebarRenderWindow({
        entries,
        estimatedViewportRows,
        overscanRows: 4,
        scrollTop: scrollViewport.top,
        selectedFileId,
        viewportHeight: scrollViewport.height,
      }),
    [entries, estimatedViewportRows, scrollViewport.height, scrollViewport.top, selectedFileId],
  );

  useEffect(() => {
    const scrollBox = scrollRef.current;
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
  }, [entries.length, scrollRef]);

  return (
    <box
      style={{
        width,
        border: ["top"],
        borderColor: theme.border,
        backgroundColor: theme.panel,
        paddingY: 1,
        paddingX: 0,
        flexDirection: "column",
      }}
    >
      <scrollbox
        ref={scrollRef}
        width="100%"
        height="100%"
        focused={false}
        scrollY={true}
        viewportCulling={true}
        rootOptions={{ backgroundColor: theme.panel }}
        wrapperOptions={{ backgroundColor: theme.panel }}
        viewportOptions={{ backgroundColor: theme.panel }}
        contentOptions={{ backgroundColor: theme.panel }}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <box style={{ width: "100%", flexDirection: "column" }}>
          {renderWindow.items.map((item) => {
            if (item.kind === "spacer") {
              return (
                <box
                  key={item.key}
                  style={{ width: "100%", height: item.height, backgroundColor: theme.panel }}
                />
              );
            }

            const { entry } = item;
            return entry.kind === "group" ? (
              <FileGroupHeader
                key={entry.id}
                entry={entry}
                nerdFontIcons={nerdFontIcons}
                textWidth={textWidth}
                theme={theme}
              />
            ) : (
              <FileListItem
                key={entry.id}
                entry={entry}
                nerdFontIcons={nerdFontIcons}
                selected={entry.id === selectedFileId}
                statsWidth={statsWidth}
                textWidth={textWidth}
                theme={theme}
                onSelectFile={onSelectFile}
              />
            );
          })}
        </box>
      </scrollbox>
    </box>
  );
}

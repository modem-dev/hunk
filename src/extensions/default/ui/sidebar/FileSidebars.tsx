import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExtensionPaneProps } from "../../../../extension-api/types";
import {
  buildFlatSidebarEntries,
  buildTreeSidebarEntries,
  resolveFileSidebarMode,
  sidebarEntryStatsWidth,
  type SidebarEntry,
} from "../../../../ui/lib/files";
import { fileRowId } from "../../../../ui/lib/ids";
import { buildSidebarRenderWindow } from "../../../../ui/lib/sidebarRenderWindow";
import {
  FileDirectoryRow,
  FileGroupHeader,
  FileListItem,
} from "../../../../ui/components/panes/FileListItem";

export type BuiltInSidebarProps = Omit<
  ExtensionPaneProps,
  "placement" | "height" | "currentLine" | "review"
> &
  Partial<Pick<ExtensionPaneProps, "placement" | "height" | "currentLine" | "review">>;

type FileSidebarVariantProps = Pick<
  BuiltInSidebarProps,
  "actions" | "files" | "selectedFileId" | "theme"
> & {
  estimatedViewportRows: number;
  scrollTop: number;
  textWidth: number;
  viewportHeight: number;
};

interface VirtualizedFileSidebarRowsProps extends Omit<FileSidebarVariantProps, "files"> {
  entries: SidebarEntry[];
  paddingLeft?: number;
}

/** Render one windowed sidebar projection with shared file selection and stats lanes. */
export function VirtualizedFileSidebarRows({
  actions,
  entries,
  estimatedViewportRows,
  paddingLeft = 1,
  scrollTop,
  selectedFileId,
  textWidth,
  theme,
  viewportHeight,
}: VirtualizedFileSidebarRowsProps): ReactNode {
  const fileEntries = entries.filter((entry) => entry.kind === "file");
  const statsWidth = Math.max(0, ...fileEntries.map((entry) => sidebarEntryStatsWidth(entry)));
  const renderWindow = useMemo(
    () =>
      buildSidebarRenderWindow({
        entries,
        estimatedViewportRows,
        overscanRows: 4,
        scrollTop,
        selectedFileId: selectedFileId ?? undefined,
        viewportHeight,
      }),
    [entries, estimatedViewportRows, scrollTop, selectedFileId, viewportHeight],
  );

  return (
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
        if (entry.kind === "group") {
          return (
            <FileGroupHeader
              key={entry.id}
              entry={entry}
              paddingLeft={paddingLeft}
              textWidth={textWidth}
              theme={theme}
            />
          );
        }
        if (entry.kind === "directory") {
          return (
            <FileDirectoryRow
              key={entry.id}
              entry={entry}
              paddingLeft={paddingLeft}
              statsWidth={statsWidth}
              textWidth={textWidth}
              theme={theme}
            />
          );
        }

        return (
          <FileListItem
            key={entry.id}
            entry={entry}
            paddingLeft={paddingLeft}
            selected={entry.id === selectedFileId}
            statsWidth={statsWidth}
            textWidth={textWidth}
            theme={theme}
            onSelectFile={actions.selectFile}
          />
        );
      })}
    </box>
  );
}

/** Render the compact directory-group projection for a narrow file sidebar. */
export function FlatFileSidebar({ files, ...props }: FileSidebarVariantProps): ReactNode {
  const entries = useMemo(() => buildFlatSidebarEntries(files), [files]);
  return <VirtualizedFileSidebarRows {...props} entries={entries} />;
}

/** Render the fully expanded ordered hierarchy for a wide file sidebar. */
export function TreeFileSidebar({ files, ...props }: FileSidebarVariantProps): ReactNode {
  const entries = useMemo(() => buildTreeSidebarEntries(files), [files]);
  return <VirtualizedFileSidebarRows {...props} entries={entries} paddingLeft={0} />;
}

/**
 * Adapt the built-in file sidebar between compact and hierarchical projections.
 *
 * Resizing only replaces the rows inside one stable scrollbox. The sidebar keeps
 * file navigation and selected-row reveal shared so both projections preserve
 * the same review-stream behavior.
 */
export function FlexFileSidebar({
  files,
  selectedFileId,
  theme,
  width,
  actions,
}: BuiltInSidebarProps): ReactNode {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [scrollViewport, setScrollViewport] = useState({ top: 0, height: 0 });
  const terminal = useTerminalDimensions();
  // Mirrors the host layout: one column of row highlight plus row padding.
  const textWidth = Math.max(8, width - 2);
  const mode = resolveFileSidebarMode(textWidth);
  const variantProps: FileSidebarVariantProps = {
    actions,
    estimatedViewportRows: terminal.height,
    files,
    scrollTop: scrollViewport.top,
    selectedFileId,
    textWidth,
    theme,
    viewportHeight: scrollViewport.height,
  };

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
  }, [files, mode]);

  // Selection and projection changes can both move the target row, so follow
  // the stable file id after either event instead of only after navigation.
  useEffect(() => {
    if (!selectedFileId) {
      return;
    }

    scrollRef.current?.scrollChildIntoView(fileRowId(selectedFileId));
  }, [files, mode, selectedFileId]);

  return (
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
      {mode === "tree" ? (
        <TreeFileSidebar {...variantProps} />
      ) : (
        <FlatFileSidebar {...variantProps} />
      )}
    </scrollbox>
  );
}

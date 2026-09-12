import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExtensionPaneProps } from "../../../../extension-api/types";
import {
  buildFlatSidebarEntries,
  buildTreeSidebarEntries,
  collapseTreeSidebarEntries,
  expandCollapsedDirectoryPaths,
  resolveFileSidebarMode,
  sidebarDirectoryPaths,
  sidebarEntryStatsWidth,
  toggleCollapsedDirectoryPath,
  type SidebarEntry,
} from "../../../../ui/lib/files";
import {
  buildSidebarRenderWindow,
  planSidebarRowReveal,
} from "../../../../ui/lib/sidebarRenderWindow";
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

/** Ignore directory toggles for projections that cannot contain directory rows. */
function ignoreDirectoryToggle() {}

interface VirtualizedFileSidebarRowsProps extends Pick<
  BuiltInSidebarProps,
  "actions" | "selectedFileId" | "theme"
> {
  collapsedDirectoryPaths?: ReadonlySet<string>;
  entries: SidebarEntry[];
  estimatedViewportRows: number;
  onToggleDirectory?: (path: string) => void;
  paddingLeft?: number;
  scrollTop: number;
  textWidth: number;
  viewportHeight: number;
}

/** Render one windowed sidebar projection with shared file selection and stats lanes. */
export function VirtualizedFileSidebarRows({
  actions,
  collapsedDirectoryPaths,
  entries,
  estimatedViewportRows,
  onToggleDirectory,
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
              collapsed={collapsedDirectoryPaths?.has(entry.path) ?? false}
              entry={entry}
              onToggleDirectory={onToggleDirectory ?? ignoreDirectoryToggle}
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

/**
 * Render the built-in file sidebar, switching between the compact directory-group
 * projection and the collapsible tree as the pane width changes.
 *
 * Resizing only replaces the rows inside one stable scrollbox. File navigation, a
 * projection change, and a reload all reveal the selected row through the same
 * fixed-row geometry the render window uses, so the reveal never depends on a row
 * having been laid out: rows mounted since the last frame carry no position yet, and
 * held-down navigation lands several commits between frames.
 */
export function FlexFileSidebar({
  files,
  selectedFileId,
  theme,
  width,
  actions,
}: BuiltInSidebarProps): ReactNode {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const previousSelectedFileIdRef = useRef(selectedFileId);
  const skipSelectedFileRevealRef = useRef(false);
  // The file whose row still has to be brought on screen. It stays set until a measured
  // viewport confirms the row is visible, so a reveal that ran before the first layout or
  // against a content height the next layout will grow retries once geometry settles.
  const pendingRevealFileIdRef = useRef<string | null>(null);
  const [collapsedDirectoryPaths, setCollapsedDirectoryPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [scrollViewport, setScrollViewport] = useState({ top: 0, height: 0 });
  const terminal = useTerminalDimensions();
  // Mirrors the host layout: one column of row highlight plus row padding.
  const textWidth = Math.max(8, width - 2);
  const mode = resolveFileSidebarMode(textWidth);
  const entries = useMemo(
    () =>
      mode === "tree"
        ? collapseTreeSidebarEntries(buildTreeSidebarEntries(files), collapsedDirectoryPaths)
        : buildFlatSidebarEntries(files),
    [collapsedDirectoryPaths, files, mode],
  );

  /** Toggle one logical directory everywhere it appears in the ordered tree projection. */
  const toggleDirectory = (path: string) => {
    skipSelectedFileRevealRef.current = true;
    setCollapsedDirectoryPaths((current) => toggleCollapsedDirectoryPath(current, path));
  };

  /**
   * Scroll the pending file's row into the viewport and clear the request once it is visible.
   *
   * Works from the row's entry index rather than its rendered position, so it is correct
   * for rows the render window mounted in this very commit. A viewport that has not been
   * measured yet, or a scroll the scrollbox clamped against a stale content height, leaves
   * the request pending for the next viewport event.
   */
  const revealPendingRow = useCallback(() => {
    const scrollBox = scrollRef.current;
    const fileId = pendingRevealFileIdRef.current;
    if (!scrollBox || !fileId) {
      return;
    }

    const entryIndex = entries.findIndex((entry) => entry.kind === "file" && entry.id === fileId);
    if (entryIndex < 0) {
      pendingRevealFileIdRef.current = null;
      return;
    }

    const viewportHeight = scrollBox.viewport.height ?? 0;
    if (viewportHeight <= 0) {
      return;
    }

    const target = planSidebarRowReveal({
      entryIndex,
      scrollTop: scrollBox.scrollTop ?? 0,
      viewportHeight,
    });
    if (target !== null) {
      scrollBox.scrollTo(target);
    }

    const stillHidden =
      planSidebarRowReveal({
        entryIndex,
        scrollTop: scrollBox.scrollTop ?? 0,
        viewportHeight,
      }) !== null;
    if (!stillHidden) {
      pendingRevealFileIdRef.current = null;
    }
  }, [entries]);
  const revealPendingRowRef = useRef(revealPendingRow);
  revealPendingRowRef.current = revealPendingRow;

  useEffect(() => {
    const previousSelectedFileId = previousSelectedFileIdRef.current;
    previousSelectedFileIdRef.current = selectedFileId;
    if (!selectedFileId || selectedFileId === previousSelectedFileId) {
      return;
    }

    const selectedFile = files.find((file) => file.id === selectedFileId);
    if (!selectedFile) {
      return;
    }

    setCollapsedDirectoryPaths((current) =>
      expandCollapsedDirectoryPaths(current, sidebarDirectoryPaths(selectedFile.path)),
    );
  }, [files, selectedFileId]);

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

    // OpenTUI emits these from its own layout and slider work; one microtask per burst
    // reads the settled geometry and gives a pending reveal its retry.
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
          revealPendingRowRef.current();
        } finally {
          scheduled = false;
        }
      });
    };

    readViewport();
    scrollBox.verticalScrollBar.on("change", handleViewportChange);
    scrollBox.viewport.on("resize", handleViewportChange);
    scrollBox.content.on("resize", handleViewportChange);

    return () => {
      cancelled = true;
      scrollBox.verticalScrollBar.off("change", handleViewportChange);
      scrollBox.viewport.off("resize", handleViewportChange);
      scrollBox.content.off("resize", handleViewportChange);
    };
  }, [files, mode]);

  // Selection and projection changes can both move the target row, so follow the stable
  // file id after either event instead of only after navigation.
  useEffect(() => {
    if (skipSelectedFileRevealRef.current) {
      skipSelectedFileRevealRef.current = false;
      return;
    }
    if (!selectedFileId) {
      return;
    }

    pendingRevealFileIdRef.current = selectedFileId;
    revealPendingRow();
  }, [revealPendingRow, selectedFileId]);

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
      <VirtualizedFileSidebarRows
        actions={actions}
        collapsedDirectoryPaths={mode === "tree" ? collapsedDirectoryPaths : undefined}
        entries={entries}
        estimatedViewportRows={terminal.height}
        onToggleDirectory={mode === "tree" ? toggleDirectory : undefined}
        paddingLeft={mode === "tree" ? 0 : 1}
        scrollTop={scrollViewport.top}
        selectedFileId={selectedFileId}
        textWidth={textWidth}
        theme={theme}
        viewportHeight={scrollViewport.height}
      />
    </scrollbox>
  );
}

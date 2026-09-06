import { mousePressSequence, recordMousePress } from "../../../../ui/lib/mousePressSequence";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExtensionPaneProps } from "../../../../extension-api/types";
import {
  buildFilePaneEntries,
  buildFlatSidebarEntries,
  buildTreeSidebarEntries,
  collapseTreeSidebarEntries,
  expandCollapsedDirectoryPaths,
  fileSidebarContentWidth,
  resolveFileSidebarMode,
  sidebarDirectoryPaths,
  sidebarEntryStatsWidth,
  toggleCollapsedDirectoryPath,
  workingTreeSidebarSources,
  type SidebarEntry,
  type SidebarFileSource,
} from "../../../../ui/lib/files";
import { filesVisuallyUnderSidebarEntry } from "../../../../ui/lib/filePaneSelection";
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

type FileSidebarVariantProps = Pick<BuiltInSidebarProps, "selectedFileId" | "theme"> & {
  files: readonly SidebarFileSource[];
  estimatedViewportRows: number;
  onSelectEntry: (entryId: string) => void;
  scrollTop: number;
  textWidth: number;
  viewportHeight: number;
};

/** Ignore directory toggles for projections that cannot contain directory rows. */
function ignoreDirectoryToggle() {}

interface VirtualizedFileSidebarRowsProps extends Omit<FileSidebarVariantProps, "files"> {
  collapsedDirectoryPaths?: ReadonlySet<string>;
  entries: SidebarEntry[];
  onToggleDirectory?: (path: string) => void;
  paddingLeft?: number;
}

/** Render one windowed sidebar projection with shared file selection and stats lanes. */
export function VirtualizedFileSidebarRows({
  collapsedDirectoryPaths,
  entries,
  estimatedViewportRows,
  onToggleDirectory,
  paddingLeft = 1,
  onSelectEntry,
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
              selected={entry.id === selectedFileId}
              statsWidth={statsWidth}
              textWidth={textWidth}
              theme={theme}
              onSelect={onSelectEntry}
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
              selected={entry.id === selectedFileId}
              statsWidth={statsWidth}
              textWidth={textWidth}
              theme={theme}
              onSelect={onSelectEntry}
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
            onSelectFile={onSelectEntry}
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

/** Render the ordered hierarchy after applying the sidebar's collapsed directory paths. */
export function TreeFileSidebar({
  collapsedDirectoryPaths,
  files,
  onToggleDirectory,
  ...props
}: FileSidebarVariantProps & {
  collapsedDirectoryPaths: ReadonlySet<string>;
  onToggleDirectory: (path: string) => void;
}): ReactNode {
  const entries = useMemo(
    () => collapseTreeSidebarEntries(buildTreeSidebarEntries(files), collapsedDirectoryPaths),
    [collapsedDirectoryPaths, files],
  );
  return (
    <VirtualizedFileSidebarRows
      {...props}
      collapsedDirectoryPaths={collapsedDirectoryPaths}
      entries={entries}
      onToggleDirectory={onToggleDirectory}
      paddingLeft={0}
    />
  );
}

/**
 * Adapt the built-in file sidebar between compact and hierarchical projections.
 *
 * Resizing only replaces the rows inside one stable scrollbox. The sidebar keeps
 * file navigation and selected-row reveal shared so both projections preserve
 * the same review-stream behavior.
 */
export function FlexFileSidebar({
  files: reviewFiles,
  selectedFileId: reviewSelectedFileId,
  theme,
  width,
  actions,
  workingTree,
}: BuiltInSidebarProps): ReactNode {
  const renderer = useRenderer();
  const statusFiles = workingTree?.files;
  const files = useMemo<readonly SidebarFileSource[]>(
    () => (statusFiles ? workingTreeSidebarSources(reviewFiles, statusFiles) : reviewFiles),
    [reviewFiles, statusFiles],
  );
  const lastClickRef = useRef<{ id: string; time: number; press: number } | null>(null);
  const [localEntryId, setLocalEntryId] = useState<string | null>(null);
  const paneEntries = useMemo(
    () => buildFilePaneEntries(files, fileSidebarContentWidth(width)),
    [files, width],
  );
  /** Only consecutive clicks on the same row may mutate the index. */
  const selectEntry = (entryId: string) => {
    const now = Date.now();
    const previous = lastClickRef.current;
    const press = mousePressSequence(renderer);
    if (
      workingTree &&
      paneEntries.find((entry) => entry.id === entryId)?.kind === "file" &&
      previous?.id === entryId &&
      press === previous.press + 1 &&
      now - previous.time < 350
    ) {
      lastClickRef.current = null;
      workingTree.toggleEntry(entryId);
      return;
    }
    lastClickRef.current = { id: entryId, time: now, press };
    if (workingTree) {
      workingTree.selectEntry(entryId);
      return;
    }
    setLocalEntryId(entryId);
    const file = files.find((candidate) => candidate.id === entryId);
    if (file) {
      actions.selectFile(file.id);
      return;
    }
    const index = paneEntries.findIndex((entry) => entry.id === entryId);
    const nested = filesVisuallyUnderSidebarEntry(paneEntries, index)[0];
    if (nested) actions.selectFile(nested.id);
  };
  const selectedFileId = workingTree?.selectedEntryId ?? localEntryId ?? reviewSelectedFileId;

  useEffect(() => {
    if (workingTree || !localEntryId || localEntryId === reviewSelectedFileId) return;
    const index = paneEntries.findIndex((entry) => entry.id === localEntryId);
    const nested = filesVisuallyUnderSidebarEntry(paneEntries, index);
    if (nested.some((entry) => entry.id === reviewSelectedFileId)) return;
    setLocalEntryId(null);
  }, [localEntryId, paneEntries, reviewSelectedFileId, workingTree]);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const previousSelectedFileIdRef = useRef(selectedFileId);
  const skipSelectedFileRevealRef = useRef(false);
  const [collapsedDirectoryPaths, setCollapsedDirectoryPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [scrollViewport, setScrollViewport] = useState({ top: 0, height: 0 });
  const terminal = useTerminalDimensions();
  // Mirrors the host layout: one column of row highlight plus row padding.
  const textWidth = fileSidebarContentWidth(width);
  const mode = resolveFileSidebarMode(textWidth);
  const variantProps: FileSidebarVariantProps = {
    estimatedViewportRows: terminal.height,
    files,
    onSelectEntry: selectEntry,
    scrollTop: scrollViewport.top,
    selectedFileId,
    textWidth,
    theme,
    viewportHeight: scrollViewport.height,
  };

  /** Toggle one logical directory everywhere it appears in the ordered tree projection. */
  const toggleDirectory = (path: string) => {
    skipSelectedFileRevealRef.current = true;
    setCollapsedDirectoryPaths((current) => toggleCollapsedDirectoryPath(current, path));
  };

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
    if (skipSelectedFileRevealRef.current) {
      skipSelectedFileRevealRef.current = false;
      return;
    }
    if (!selectedFileId) {
      return;
    }

    scrollRef.current?.scrollChildIntoView(fileRowId(selectedFileId));
  }, [collapsedDirectoryPaths, files, mode, selectedFileId]);

  return (
    <scrollbox
      onMouseDown={(event) => recordMousePress(renderer, event)}
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
        <TreeFileSidebar
          {...variantProps}
          collapsedDirectoryPaths={collapsedDirectoryPaths}
          onToggleDirectory={toggleDirectory}
        />
      ) : (
        <FlatFileSidebar {...variantProps} />
      )}
    </scrollbox>
  );
}

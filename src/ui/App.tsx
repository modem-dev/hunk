import {
  MouseButton,
  type KeyEvent,
  type MouseEvent as TuiMouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  useRef,
} from "react";
import { resolveConfiguredCliInput } from "../core/config";
import { loadAppBootstrap } from "../core/loaders";
import { resolveRuntimeCliInput } from "../core/terminal";
import type { AppBootstrap, CliInput, LayoutMode } from "../core/types";
import { canReloadInput, computeWatchSignature } from "../core/watch";
import { HunkHostClient } from "../mcp/client";
import {
  createInitialSessionSnapshot,
  updateSessionRegistration,
} from "../mcp/sessionRegistration";
import type { ReloadedSessionResult } from "../mcp/types";
import { MenuBar } from "./components/chrome/MenuBar";
import { StatusBar } from "./components/chrome/StatusBar";
import { DiffPane } from "./components/panes/DiffPane";
import { FilesPane } from "./components/panes/FilesPane";
import { PaneDivider } from "./components/panes/PaneDivider";
import { useHunkSessionBridge } from "./hooks/useHunkSessionBridge";
import { useMenuController } from "./hooks/useMenuController";
import { buildAppMenus } from "./lib/appMenus";
import { buildSidebarEntries } from "./lib/files";
import { buildHunkCursors, findNextHunkCursor } from "./lib/hunks";
import { fileRowId } from "./lib/ids";
import { resolveResponsiveLayout } from "./lib/responsive";
import { resizeSidebarWidth } from "./lib/sidebar";
import { resolveTheme, THEMES } from "./themes";

type FocusArea = "files" | "filter";

const LazyHelpDialog = lazy(async () => ({
  default: (await import("./components/chrome/HelpDialog")).HelpDialog,
}));
const LazyMenuDropdown = lazy(async () => ({
  default: (await import("./components/chrome/MenuDropdown")).MenuDropdown,
}));

/** Clamp a value into an inclusive range. */
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Preserve the active shell view settings when rebuilding the current input. */
function withCurrentViewOptions(
  input: CliInput,
  view: {
    layoutMode: LayoutMode;
    themeId: string;
    showAgentNotes: boolean;
    showHunkHeaders: boolean;
    showLineNumbers: boolean;
    wrapLines: boolean;
  },
): CliInput {
  return {
    ...input,
    options: {
      ...input.options,
      mode: view.layoutMode,
      theme: view.themeId,
      agentNotes: view.showAgentNotes,
      hunkHeaders: view.showHunkHeaders,
      lineNumbers: view.showLineNumbers,
      wrapLines: view.wrapLines,
    },
  };
}

/** Orchestrate global app state, layout, navigation, and pane coordination. */
function AppShell({
  bootstrap,
  hostClient,
  onQuit = () => process.exit(0),
  onReloadSession,
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkHostClient;
  onQuit?: () => void;
  onReloadSession: (
    nextInput: CliInput,
    options?: { resetShell?: boolean },
  ) => Promise<ReloadedSessionResult>;
}) {
  const FILES_MIN_WIDTH = 22;
  const DIFF_MIN_WIDTH = 48;
  const BODY_PADDING = 2;
  const DIVIDER_WIDTH = 1;
  const DIVIDER_HIT_WIDTH = 5;

  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const filesScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(bootstrap.initialMode);
  const [themeId, setThemeId] = useState(
    () => resolveTheme(bootstrap.initialTheme, renderer.themeMode).id,
  );
  const [showAgentNotes, setShowAgentNotes] = useState(bootstrap.initialShowAgentNotes ?? false);
  const [showLineNumbers, setShowLineNumbers] = useState(bootstrap.initialShowLineNumbers ?? true);
  const [wrapLines, setWrapLines] = useState(bootstrap.initialWrapLines ?? false);
  const [showHunkHeaders, setShowHunkHeaders] = useState(bootstrap.initialShowHunkHeaders ?? true);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [forceSidebarOpen, setForceSidebarOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [focusArea, setFocusArea] = useState<FocusArea>("files");
  const [filter, setFilter] = useState("");
  const [filesPaneWidth, setFilesPaneWidth] = useState(34);
  const [resizeDragOriginX, setResizeDragOriginX] = useState<number | null>(null);
  const [resizeStartWidth, setResizeStartWidth] = useState<number | null>(null);
  const [selectedFileId, setSelectedFileId] = useState(bootstrap.changeset.files[0]?.id ?? "");
  const [selectedHunkIndex, setSelectedHunkIndex] = useState(0);
  const deferredFilter = useDeferredValue(filter);

  const pagerMode = Boolean(bootstrap.input.options.pager);
  const activeTheme = resolveTheme(themeId, renderer.themeMode);

  const jumpToFile = useCallback((fileId: string, nextHunkIndex = 0) => {
    filesScrollRef.current?.scrollChildIntoView(fileRowId(fileId));
    setSelectedFileId(fileId);
    setSelectedHunkIndex(nextHunkIndex);
  }, []);

  const openAgentNotes = useCallback(() => {
    setShowAgentNotes(true);
  }, []);

  const baseSelectedFile =
    bootstrap.changeset.files.find((file) => file.id === selectedFileId) ??
    bootstrap.changeset.files[0];
  const { liveCommentsByFileId } = useHunkSessionBridge({
    currentHunk: baseSelectedFile?.metadata.hunks[selectedHunkIndex],
    files: bootstrap.changeset.files,
    hostClient,
    jumpToFile,
    openAgentNotes,
    reloadSession: onReloadSession,
    selectedFile: baseSelectedFile,
    selectedHunkIndex,
    showAgentNotes,
  });

  const allFiles = useMemo(
    () =>
      bootstrap.changeset.files.map((file) => {
        const liveComments = liveCommentsByFileId[file.id];
        if (!liveComments || liveComments.length === 0) {
          return file;
        }

        return {
          ...file,
          agent: {
            path: file.path,
            summary: file.agent?.summary,
            annotations: [...(file.agent?.annotations ?? []), ...liveComments],
          },
        };
      }),
    [bootstrap.changeset.files, liveCommentsByFileId],
  );

  const filteredFiles = allFiles.filter((file) => {
    if (!deferredFilter.trim()) {
      return true;
    }

    const haystack = [file.path, file.previousPath, file.agent?.summary]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(deferredFilter.trim().toLowerCase());
  });

  const selectedFile =
    filteredFiles.find((file) => file.id === selectedFileId) ??
    allFiles.find((file) => file.id === selectedFileId) ??
    filteredFiles[0];
  const hunkCursors = buildHunkCursors(filteredFiles);

  const bodyPadding = pagerMode ? 0 : BODY_PADDING;
  const bodyWidth = Math.max(0, terminal.width - bodyPadding);
  const responsiveLayout = resolveResponsiveLayout(layoutMode, terminal.width);
  const canForceShowFilesPane = bodyWidth >= FILES_MIN_WIDTH + DIVIDER_WIDTH + DIFF_MIN_WIDTH;
  const showFilesPane = pagerMode
    ? false
    : sidebarVisible &&
      (responsiveLayout.showFilesPane || (forceSidebarOpen && canForceShowFilesPane));
  const centerWidth = bodyWidth;
  const resolvedLayout = responsiveLayout.layout;
  const availableCenterWidth = showFilesPane
    ? Math.max(0, centerWidth - DIVIDER_WIDTH)
    : Math.max(0, centerWidth);
  const maxFilesPaneWidth = showFilesPane
    ? Math.max(FILES_MIN_WIDTH, availableCenterWidth - DIFF_MIN_WIDTH)
    : FILES_MIN_WIDTH;
  const clampedFilesPaneWidth = showFilesPane
    ? clamp(filesPaneWidth, FILES_MIN_WIDTH, maxFilesPaneWidth)
    : 0;
  const diffPaneWidth = showFilesPane
    ? Math.max(DIFF_MIN_WIDTH, availableCenterWidth - clampedFilesPaneWidth)
    : Math.max(0, availableCenterWidth);
  const isResizingFilesPane = resizeDragOriginX !== null && resizeStartWidth !== null;
  const dividerHitLeft = Math.max(
    1,
    1 + clampedFilesPaneWidth - Math.floor((DIVIDER_HIT_WIDTH - DIVIDER_WIDTH) / 2),
  );

  useEffect(() => {
    if (!showFilesPane) {
      setResizeDragOriginX(null);
      setResizeStartWidth(null);
      return;
    }

    setFilesPaneWidth((current) => clamp(current, FILES_MIN_WIDTH, maxFilesPaneWidth));
  }, [maxFilesPaneWidth, showFilesPane]);

  useEffect(() => {
    // Force an intermediate redraw when the shell geometry changes so pane relayout feels immediate.
    renderer.intermediateRender();
  }, [renderer, resolvedLayout, showFilesPane, terminal.height, terminal.width]);

  useEffect(() => {
    if (!selectedFile && filteredFiles[0]) {
      setSelectedFileId(filteredFiles[0].id);
      setSelectedHunkIndex(0);
      return;
    }

    if (
      selectedFile &&
      !filteredFiles.some((file) => file.id === selectedFile.id) &&
      filteredFiles[0]
    ) {
      startTransition(() => {
        setSelectedFileId(filteredFiles[0]!.id);
        setSelectedHunkIndex(0);
      });
    }
  }, [filteredFiles, selectedFile]);

  useEffect(() => {
    if (!selectedFile) {
      return;
    }

    const maxIndex = Math.max(0, selectedFile.metadata.hunks.length - 1);
    setSelectedHunkIndex((current) => clamp(current, 0, maxIndex));
  }, [selectedFile]);

  useEffect(() => {
    if (!selectedFile) {
      return;
    }

    filesScrollRef.current?.scrollChildIntoView(fileRowId(selectedFile.id));
  }, [selectedFile]);

  /** Move the review focus across hunks in stream order. */
  const moveHunk = (delta: number) => {
    const nextCursor = findNextHunkCursor(hunkCursors, selectedFile?.id, selectedHunkIndex, delta);
    if (!nextCursor) {
      return;
    }

    filesScrollRef.current?.scrollChildIntoView(fileRowId(nextCursor.fileId));
    setSelectedFileId(nextCursor.fileId);
    setSelectedHunkIndex(nextCursor.hunkIndex);
  };

  /** Scroll the main review pane by line steps, viewport fractions, or whole-content jumps. */
  const scrollDiff = (delta: number, unit: "step" | "viewport" | "content" = "viewport") => {
    diffScrollRef.current?.scrollBy(delta, unit);
  };

  /** Cycle only through files that have agent context attached. */
  const moveAnnotatedFile = (delta: number) => {
    const annotated = filteredFiles.filter((file) => file.agent);
    if (annotated.length === 0) {
      return;
    }

    const currentIndex = annotated.findIndex((file) => file.id === selectedFile?.id);
    const normalizedIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (normalizedIndex + delta + annotated.length) % annotated.length;
    const nextFile = annotated[nextIndex];
    if (!nextFile) {
      return;
    }

    jumpToFile(nextFile.id);
  };

  /** Toggle the global agent note layer on or off. */
  const toggleAgentNotes = () => {
    setShowAgentNotes((current) => !current);
  };

  /** Toggle line-number gutters without changing the diff content itself. */
  const toggleLineNumbers = () => {
    setShowLineNumbers((current) => !current);
  };

  /** Toggle whether diff code rows wrap instead of truncating to one terminal row. */
  const toggleLineWrap = () => {
    setWrapLines((current) => !current);
  };

  /** Toggle the sidebar, forcing it open on narrower layouts when the shell can still fit both panes. */
  const toggleSidebar = () => {
    if (sidebarVisible && (responsiveLayout.showFilesPane || forceSidebarOpen)) {
      setSidebarVisible(false);
      setForceSidebarOpen(false);
      return;
    }

    if (sidebarVisible && !responsiveLayout.showFilesPane) {
      if (canForceShowFilesPane) {
        setForceSidebarOpen(true);
      }
      return;
    }

    setSidebarVisible(true);
    setForceSidebarOpen(!responsiveLayout.showFilesPane && canForceShowFilesPane);
  };

  /** Toggle visibility of hunk metadata rows without changing the actual diff lines. */
  const toggleHunkHeaders = () => {
    setShowHunkHeaders((current) => !current);
  };

  /** Jump to an annotated hunk without changing the global note visibility toggle. */
  const openAgentNotesAtHunk = (fileId: string, hunkIndex: number) => {
    jumpToFile(fileId, hunkIndex);
  };

  const canRefreshCurrentInput = canReloadInput(bootstrap.input);
  const watchEnabled = Boolean(bootstrap.input.options.watch && canRefreshCurrentInput);

  /** Rebuild the current diff source while preserving the active shell view options. */
  const refreshCurrentInput = useCallback(async () => {
    if (!canRefreshCurrentInput) {
      return;
    }

    const nextInput = withCurrentViewOptions(bootstrap.input, {
      layoutMode,
      themeId,
      showAgentNotes,
      showHunkHeaders,
      showLineNumbers,
      wrapLines,
    });

    await onReloadSession(nextInput, { resetShell: false });
  }, [
    bootstrap.input,
    canRefreshCurrentInput,
    layoutMode,
    onReloadSession,
    showAgentNotes,
    showHunkHeaders,
    showLineNumbers,
    themeId,
    wrapLines,
  ]);

  const triggerRefreshCurrentInput = useCallback(() => {
    void refreshCurrentInput().catch((error) => {
      console.error("Failed to reload the current diff.", error);
    });
  }, [refreshCurrentInput]);

  useEffect(() => {
    if (!watchEnabled) {
      return;
    }

    let cancelled = false;
    let polling = false;
    let refreshing = false;
    let lastSignature: string;

    try {
      lastSignature = computeWatchSignature(bootstrap.input);
    } catch (error) {
      console.error("Failed to initialize watch mode.", error);
      return;
    }

    const pollForChanges = () => {
      if (cancelled || polling || refreshing) {
        return;
      }

      polling = true;

      try {
        const nextSignature = computeWatchSignature(bootstrap.input);
        if (nextSignature !== lastSignature) {
          lastSignature = nextSignature;
          refreshing = true;
          void refreshCurrentInput()
            .catch((error) => {
              console.error("Failed to auto-reload the current diff.", error);
            })
            .finally(() => {
              refreshing = false;
            });
        }
      } catch (error) {
        console.error("Failed to poll watch mode input.", error);
      } finally {
        polling = false;
      }
    };

    const interval = setInterval(pollForChanges, 250);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [bootstrap.input, refreshCurrentInput, watchEnabled]);

  /** Leave the app through the shell-owned shutdown path. */
  const requestQuit = useCallback(() => {
    onQuit();
  }, [onQuit]);

  const menus = useMemo(
    () =>
      buildAppMenus({
        activeThemeId: activeTheme.id,
        canRefreshCurrentInput,
        focusFiles: () => setFocusArea("files"),
        focusFilter: () => setFocusArea("filter"),
        layoutMode,
        moveAnnotatedFile,
        moveHunk,
        refreshCurrentInput: triggerRefreshCurrentInput,
        requestQuit,
        selectLayoutMode: setLayoutMode,
        selectThemeId: setThemeId,
        showAgentNotes,
        showHelp,
        showHunkHeaders,
        showLineNumbers,
        sidebarVisible,
        toggleAgentNotes,
        toggleHelp: () => setShowHelp((current) => !current),
        toggleHunkHeaders,
        toggleLineNumbers,
        toggleLineWrap,
        toggleSidebar,
        wrapLines,
      }),
    [
      activeTheme.id,
      canRefreshCurrentInput,
      layoutMode,
      moveAnnotatedFile,
      moveHunk,
      requestQuit,
      triggerRefreshCurrentInput,
      showAgentNotes,
      showHelp,
      showHunkHeaders,
      showLineNumbers,
      sidebarVisible,
      toggleAgentNotes,
      toggleHunkHeaders,
      toggleLineNumbers,
      toggleLineWrap,
      toggleSidebar,
      wrapLines,
    ],
  );

  const {
    activeMenuEntries,
    activeMenuId,
    activeMenuItemIndex,
    activeMenuSpec,
    activeMenuWidth,
    activateCurrentMenuItem,
    closeMenu,
    menuSpecs,
    moveMenuItem,
    openMenu,
    setActiveMenuItemIndex,
    switchMenu,
    toggleMenu,
  } = useMenuController(menus);

  /** Start a mouse drag resize for the optional files pane. */
  const beginFilesPaneResize = (event: TuiMouseEvent) => {
    if (event.button !== MouseButton.LEFT) {
      return;
    }

    closeMenu();
    setResizeDragOriginX(event.x);
    setResizeStartWidth(clampedFilesPaneWidth);
    event.preventDefault();
    event.stopPropagation();
  };

  /** Update the files pane width while a drag resize is active. */
  const updateFilesPaneResize = (event: TuiMouseEvent) => {
    if (!isResizingFilesPane || resizeDragOriginX === null || resizeStartWidth === null) {
      return;
    }

    setFilesPaneWidth(
      resizeSidebarWidth(
        resizeStartWidth,
        resizeDragOriginX,
        event.x,
        FILES_MIN_WIDTH,
        maxFilesPaneWidth,
      ),
    );
    event.preventDefault();
    event.stopPropagation();
  };

  /** End the current files pane resize interaction. */
  const endFilesPaneResize = (event?: TuiMouseEvent) => {
    if (!isResizingFilesPane) {
      return;
    }

    setResizeDragOriginX(null);
    setResizeStartWidth(null);
    event?.preventDefault();
    event?.stopPropagation();
  };

  const fileEntries = buildSidebarEntries(filteredFiles);
  const totalAdditions = bootstrap.changeset.files.reduce(
    (sum, file) => sum + file.stats.additions,
    0,
  );
  const totalDeletions = bootstrap.changeset.files.reduce(
    (sum, file) => sum + file.stats.deletions,
    0,
  );
  const topTitle = `${bootstrap.changeset.title}  +${totalAdditions}  -${totalDeletions}`;
  const filesTextWidth = Math.max(8, clampedFilesPaneWidth - 2);
  const diffContentWidth = Math.max(12, diffPaneWidth - 2);
  const diffHeaderStatsWidth = Math.min(24, Math.max(16, Math.floor(diffContentWidth / 3)));
  const diffHeaderLabelWidth = Math.max(8, diffContentWidth - diffHeaderStatsWidth - 1);
  const diffSeparatorWidth = Math.max(4, diffContentWidth - 2);

  useKeyboard((key: KeyEvent) => {
    const pageDownKey =
      key.name === "pagedown" || key.name === "space" || key.name === " " || key.sequence === " ";
    const pageUpKey = key.name === "pageup" || key.name === "b" || key.sequence === "b";
    const stepDownKey = key.name === "down" || key.name === "j" || key.sequence === "j";
    const stepUpKey = key.name === "up" || key.name === "k" || key.sequence === "k";

    if (key.name === "f10") {
      if (pagerMode) {
        return;
      }

      if (activeMenuId) {
        closeMenu();
      } else {
        openMenu("file");
      }
      return;
    }

    if (pagerMode) {
      if (key.name === "q" || key.name === "escape") {
        requestQuit();
        return;
      }

      if (pageDownKey) {
        scrollDiff(1, "viewport");
        return;
      }

      if (pageUpKey) {
        scrollDiff(-1, "viewport");
        return;
      }

      if (stepDownKey) {
        scrollDiff(1, "step");
        return;
      }

      if (stepUpKey) {
        scrollDiff(-1, "step");
        return;
      }

      if (key.name === "home") {
        scrollDiff(-1, "content");
        return;
      }

      if (key.name === "end") {
        scrollDiff(1, "content");
        return;
      }

      return;
    }

    if (showHelp && key.name === "escape") {
      setShowHelp(false);
      return;
    }

    if (activeMenuId) {
      if (key.name === "escape") {
        closeMenu();
        return;
      }

      if (key.name === "left") {
        switchMenu(-1);
        return;
      }

      if (key.name === "right" || key.name === "tab") {
        switchMenu(1);
        return;
      }

      if (key.name === "up") {
        moveMenuItem(-1);
        return;
      }

      if (key.name === "down") {
        moveMenuItem(1);
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        activateCurrentMenuItem();
        return;
      }
    }

    if (focusArea === "filter") {
      if (key.name === "escape") {
        if (filter.length > 0) {
          setFilter("");
          return;
        }

        setFocusArea("files");
        return;
      }

      if (key.name === "tab") {
        setFocusArea("files");
        return;
      }

      // Let the input widget own typing while the filter is focused.
      return;
    }

    if (key.name === "q") {
      requestQuit();
      return;
    }

    if (key.name === "?") {
      setShowHelp((current) => !current);
      closeMenu();
      return;
    }

    if (key.name === "escape") {
      requestQuit();
      return;
    }

    if (key.name === "tab") {
      setFocusArea((current) => (current === "files" ? "filter" : "files"));
      return;
    }

    if (key.name === "/") {
      setFocusArea("filter");
      return;
    }

    if (pageDownKey) {
      scrollDiff(1, "viewport");
      return;
    }

    if (pageUpKey) {
      scrollDiff(-1, "viewport");
      return;
    }

    if (key.name === "home") {
      scrollDiff(-1, "content");
      return;
    }

    if (key.name === "end") {
      scrollDiff(1, "content");
      return;
    }

    if (key.name === "up") {
      scrollDiff(-1, "step");
      return;
    }

    if (key.name === "down") {
      scrollDiff(1, "step");
      return;
    }

    if (key.name === "1") {
      setLayoutMode("split");
      closeMenu();
      return;
    }

    if (key.name === "2") {
      setLayoutMode("stack");
      closeMenu();
      return;
    }

    if (key.name === "0") {
      setLayoutMode("auto");
      closeMenu();
      return;
    }

    if (key.name === "s") {
      toggleSidebar();
      closeMenu();
      return;
    }

    if ((key.name === "r" || key.sequence === "r") && canRefreshCurrentInput) {
      triggerRefreshCurrentInput();
      closeMenu();
      return;
    }

    if (key.name === "t") {
      const currentIndex = THEMES.findIndex((theme) => theme.id === activeTheme.id);
      const nextIndex = (currentIndex + 1) % THEMES.length;
      setThemeId(THEMES[nextIndex]!.id);
      closeMenu();
      return;
    }

    if (key.name === "a") {
      toggleAgentNotes();
      closeMenu();
      return;
    }

    if (key.name === "l" || key.sequence === "l") {
      toggleLineNumbers();
      closeMenu();
      return;
    }

    if (key.name === "w" || key.sequence === "w") {
      toggleLineWrap();
      closeMenu();
      return;
    }

    if (key.name === "m" || key.sequence === "m") {
      toggleHunkHeaders();
      closeMenu();
      return;
    }

    if (key.name === "[") {
      moveHunk(-1);
      closeMenu();
      return;
    }

    if (key.name === "]") {
      moveHunk(1);
      closeMenu();
      return;
    }
  });

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: activeTheme.background,
      }}
    >
      {!pagerMode ? (
        <MenuBar
          activeMenuId={activeMenuId}
          menuSpecs={menuSpecs}
          terminalWidth={terminal.width}
          theme={activeTheme}
          topTitle={topTitle}
          onHoverMenu={(menuId) => {
            if (activeMenuId) {
              openMenu(menuId);
            }
          }}
          onToggleMenu={toggleMenu}
        />
      ) : null}

      <box
        style={{
          flexGrow: 1,
          flexDirection: "row",
          gap: 0,
          paddingLeft: bodyPadding / 2,
          paddingRight: bodyPadding / 2,
          paddingTop: 0,
          paddingBottom: 0,
          position: "relative",
        }}
        onMouseDrag={updateFilesPaneResize}
        onMouseDragEnd={endFilesPaneResize}
        onMouseUp={(event) => {
          endFilesPaneResize(event);
          closeMenu();
        }}
      >
        {showFilesPane ? (
          <>
            <FilesPane
              entries={fileEntries}
              scrollRef={filesScrollRef}
              selectedFileId={selectedFile?.id}
              textWidth={filesTextWidth}
              theme={activeTheme}
              width={clampedFilesPaneWidth}
              onSelectFile={(fileId) => {
                setFocusArea("files");
                jumpToFile(fileId);
              }}
            />

            <PaneDivider
              dividerHitLeft={dividerHitLeft}
              dividerHitWidth={DIVIDER_HIT_WIDTH}
              isResizing={isResizingFilesPane}
              theme={activeTheme}
              onMouseDown={beginFilesPaneResize}
              onMouseDrag={updateFilesPaneResize}
              onMouseDragEnd={endFilesPaneResize}
              onMouseUp={endFilesPaneResize}
            />
          </>
        ) : null}

        <DiffPane
          diffContentWidth={diffContentWidth}
          files={filteredFiles}
          pagerMode={pagerMode}
          headerLabelWidth={diffHeaderLabelWidth}
          headerStatsWidth={diffHeaderStatsWidth}
          layout={resolvedLayout}
          scrollRef={diffScrollRef}
          selectedFileId={selectedFile?.id}
          selectedHunkIndex={selectedHunkIndex}
          separatorWidth={diffSeparatorWidth}
          showAgentNotes={showAgentNotes}
          showLineNumbers={showLineNumbers}
          showHunkHeaders={showHunkHeaders}
          wrapLines={wrapLines}
          theme={activeTheme}
          width={diffPaneWidth}
          onOpenAgentNotesAtHunk={openAgentNotesAtHunk}
          onSelectFile={jumpToFile}
        />
      </box>

      {!pagerMode && (focusArea === "filter" || Boolean(filter)) ? (
        <StatusBar
          filter={filter}
          filterFocused={focusArea === "filter"}
          terminalWidth={terminal.width}
          theme={activeTheme}
          onCloseMenu={closeMenu}
          onFilterInput={setFilter}
          onFilterSubmit={() => setFocusArea("files")}
        />
      ) : null}

      {!pagerMode && activeMenuId && activeMenuSpec ? (
        <Suspense fallback={null}>
          <LazyMenuDropdown
            activeMenuId={activeMenuId}
            activeMenuEntries={activeMenuEntries}
            activeMenuItemIndex={activeMenuItemIndex}
            activeMenuSpec={activeMenuSpec}
            activeMenuWidth={activeMenuWidth}
            terminalWidth={terminal.width}
            theme={activeTheme}
            onHoverItem={setActiveMenuItemIndex}
            onSelectItem={(entry) => {
              entry.action();
              closeMenu();
            }}
          />
        </Suspense>
      ) : null}

      {!pagerMode && showHelp ? (
        <Suspense fallback={null}>
          <LazyHelpDialog
            canRefresh={canRefreshCurrentInput}
            terminalHeight={terminal.height}
            terminalWidth={terminal.width}
            theme={activeTheme}
            onClose={() => setShowHelp(false)}
          />
        </Suspense>
      ) : null}
    </box>
  );
}

/** Keep one live Hunk window mounted while allowing daemon-driven session reloads. */
export function App({
  bootstrap,
  hostClient,
  onQuit = () => process.exit(0),
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkHostClient;
  onQuit?: () => void;
}) {
  const [activeBootstrap, setActiveBootstrap] = useState(bootstrap);
  const [shellVersion, setShellVersion] = useState(0);

  const reloadSession = useCallback(
    async (nextInput: CliInput, options?: { resetShell?: boolean }) => {
      const runtimeInput = resolveRuntimeCliInput(nextInput);
      const configuredInput = resolveConfiguredCliInput(runtimeInput).input;
      const nextBootstrap = await loadAppBootstrap(configuredInput);
      const nextSnapshot = createInitialSessionSnapshot(nextBootstrap);

      let sessionId = "local-session";
      if (hostClient) {
        const nextRegistration = updateSessionRegistration(
          hostClient.getRegistration(),
          nextBootstrap,
        );
        sessionId = nextRegistration.sessionId;
        hostClient.replaceSession(nextRegistration, nextSnapshot);
      }

      setActiveBootstrap(nextBootstrap);
      if (options?.resetShell !== false) {
        setShellVersion((current) => current + 1);
      }

      return {
        sessionId,
        inputKind: nextBootstrap.input.kind,
        title: nextBootstrap.changeset.title,
        sourceLabel: nextBootstrap.changeset.sourceLabel,
        fileCount: nextBootstrap.changeset.files.length,
        selectedFilePath: nextSnapshot.selectedFilePath,
        selectedHunkIndex: nextSnapshot.selectedHunkIndex,
      };
    },
    [hostClient],
  );

  return (
    <AppShell
      key={shellVersion}
      bootstrap={activeBootstrap}
      hostClient={hostClient}
      onQuit={onQuit}
      onReloadSession={reloadSession}
    />
  );
}

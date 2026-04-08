import {
  MouseButton,
  type MouseEvent as TuiMouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, useRef } from "react";
import type { AppBootstrap, CliInput, LayoutMode } from "../core/types";
import { canReloadInput, computeWatchSignature } from "../core/watch";
import { HunkHostClient } from "../mcp/client";
import type { ReloadedSessionResult } from "../mcp/types";
import { MenuBar } from "./components/chrome/MenuBar";
import { StatusBar } from "./components/chrome/StatusBar";
import { DiffPane } from "./components/panes/DiffPane";
import { SidebarPane } from "./components/panes/SidebarPane";
import { PaneDivider } from "./components/panes/PaneDivider";
import {
  findMaxLineNumber,
  maxFileCodeLineWidth,
  resolveCodeViewportWidth,
} from "./diff/codeColumns";
import { useAppKeyboardShortcuts } from "./hooks/useAppKeyboardShortcuts";
import { useHunkSessionBridge } from "./hooks/useHunkSessionBridge";
import { useMenuController } from "./hooks/useMenuController";
import { useReviewController } from "./hooks/useReviewController";
import { buildAppMenus } from "./lib/appMenus";
import { fileRowId } from "./lib/ids";
import { resolveResponsiveLayout } from "./lib/responsive";
import { resizeSidebarWidth } from "./lib/sidebar";
import { resolveTheme, THEMES } from "./themes";

type FocusArea = "files" | "filter";

const FAST_CODE_HORIZONTAL_SCROLL_COLUMNS = 8;

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

/** Preserve the active app view settings when rebuilding the current input. */
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
export function App({
  bootstrap,
  hostClient,
  noticeText,
  onQuit = () => process.exit(0),
  onReloadSession,
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkHostClient;
  noticeText?: string | null;
  onQuit?: () => void;
  onReloadSession: (
    nextInput: CliInput,
    options?: { resetApp?: boolean; sourcePath?: string },
  ) => Promise<ReloadedSessionResult>;
}) {
  const SIDEBAR_MIN_WIDTH = 22;
  const DIFF_MIN_WIDTH = 48;
  const BODY_PADDING = 2;
  const DIVIDER_WIDTH = 1;
  const DIVIDER_HIT_WIDTH = 5;

  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const sidebarScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const wrapToggleScrollTopRef = useRef<number | null>(null);
  const layoutToggleScrollTopRef = useRef<number | null>(null);
  const [layoutToggleRequestId, setLayoutToggleRequestId] = useState(0);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(bootstrap.initialMode);
  const [themeId, setThemeId] = useState(
    () => resolveTheme(bootstrap.initialTheme, renderer.themeMode).id,
  );
  const [showAgentNotes, setShowAgentNotes] = useState(bootstrap.initialShowAgentNotes ?? false);
  const [showLineNumbers, setShowLineNumbers] = useState(bootstrap.initialShowLineNumbers ?? true);
  const [wrapLines, setWrapLines] = useState(bootstrap.initialWrapLines ?? false);
  const [codeHorizontalOffset, setCodeHorizontalOffset] = useState(0);
  const [showHunkHeaders, setShowHunkHeaders] = useState(bootstrap.initialShowHunkHeaders ?? true);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [forceSidebarOpen, setForceSidebarOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [focusArea, setFocusArea] = useState<FocusArea>("files");
  const [sidebarWidth, setSidebarWidth] = useState(34);
  const [resizeDragOriginX, setResizeDragOriginX] = useState<number | null>(null);
  const [resizeStartWidth, setResizeStartWidth] = useState<number | null>(null);

  const pagerMode = Boolean(bootstrap.input.options.pager);
  const activeTheme = resolveTheme(themeId, renderer.themeMode);
  const review = useReviewController({ files: bootstrap.changeset.files });
  const filteredFiles = review.visibleFiles;
  const selectedFile = review.selectedFile;
  const selectedHunkIndex = review.selectedHunkIndex;
  const moveToAnnotatedFile = review.moveToAnnotatedFile;
  const moveToAnnotatedHunk = review.moveToAnnotatedHunk;

  const jumpToFile = useCallback(
    (fileId: string, nextHunkIndex = 0, options?: { alignFileHeaderTop?: boolean }) => {
      review.selectFile(fileId, nextHunkIndex, {
        alignFileHeaderTop: options?.alignFileHeaderTop,
      });
    },
    [review.selectFile],
  );

  const openAgentNotes = useCallback(() => {
    setShowAgentNotes(true);
  }, []);

  useHunkSessionBridge({
    addLiveComment: review.addLiveComment,
    addLiveCommentBatch: review.addLiveCommentBatch,
    clearLiveComments: review.clearLiveComments,
    hostClient,
    liveCommentCount: review.liveCommentCount,
    liveCommentSummaries: review.liveCommentSummaries,
    navigateToLocation: review.navigateToLocation,
    openAgentNotes,
    reloadSession: onReloadSession,
    removeLiveComment: review.removeLiveComment,
    selectedFile,
    selectedHunk: review.selectedHunk,
    selectedHunkIndex,
    showAgentNotes,
  });

  const bodyPadding = pagerMode ? 0 : BODY_PADDING;
  const bodyWidth = Math.max(0, terminal.width - bodyPadding);
  const responsiveLayout = resolveResponsiveLayout(layoutMode, terminal.width);
  const canForceShowSidebar = bodyWidth >= SIDEBAR_MIN_WIDTH + DIVIDER_WIDTH + DIFF_MIN_WIDTH;
  const renderSidebar = pagerMode
    ? false
    : sidebarVisible && (responsiveLayout.showSidebar || (forceSidebarOpen && canForceShowSidebar));
  const centerWidth = bodyWidth;
  const resolvedLayout = responsiveLayout.layout;
  const availableCenterWidth = renderSidebar
    ? Math.max(0, centerWidth - DIVIDER_WIDTH)
    : Math.max(0, centerWidth);
  const maxSidebarWidth = renderSidebar
    ? Math.max(SIDEBAR_MIN_WIDTH, availableCenterWidth - DIFF_MIN_WIDTH)
    : SIDEBAR_MIN_WIDTH;
  const clampedSidebarWidth = renderSidebar
    ? clamp(sidebarWidth, SIDEBAR_MIN_WIDTH, maxSidebarWidth)
    : 0;
  const diffPaneWidth = renderSidebar
    ? Math.max(DIFF_MIN_WIDTH, availableCenterWidth - clampedSidebarWidth)
    : Math.max(0, availableCenterWidth);
  const diffContentWidth = Math.max(12, diffPaneWidth - 2);
  const maxVisibleLineNumber = useMemo(
    () =>
      filteredFiles.reduce(
        (maxLineNumber, file) => Math.max(maxLineNumber, findMaxLineNumber(file)),
        1,
      ),
    [filteredFiles],
  );
  const maxLineNumberDigits = String(maxVisibleLineNumber).length;
  const codeViewportWidth = useMemo(
    () =>
      resolveCodeViewportWidth(
        resolvedLayout,
        diffContentWidth,
        maxLineNumberDigits,
        showLineNumbers,
      ),
    [diffContentWidth, maxLineNumberDigits, resolvedLayout, showLineNumbers],
  );
  const isResizingSidebar = resizeDragOriginX !== null && resizeStartWidth !== null;
  const dividerHitLeft = Math.max(
    1,
    1 + clampedSidebarWidth - Math.floor((DIVIDER_HIT_WIDTH - DIVIDER_WIDTH) / 2),
  );

  useEffect(() => {
    if (!renderSidebar) {
      setResizeDragOriginX(null);
      setResizeStartWidth(null);
      return;
    }

    setSidebarWidth((current) => clamp(current, SIDEBAR_MIN_WIDTH, maxSidebarWidth));
  }, [maxSidebarWidth, renderSidebar]);

  useEffect(() => {
    // Force an intermediate redraw when app geometry or row-wrapping changes so pane relayout
    // feels immediate after toggling split/stack or line wrapping.
    renderer.intermediateRender();
  }, [renderer, renderSidebar, resolvedLayout, terminal.height, terminal.width, wrapLines]);

  useEffect(() => {
    if (!selectedFile) {
      return;
    }

    sidebarScrollRef.current?.scrollChildIntoView(fileRowId(selectedFile.id));
  }, [selectedFile]);

  /** Scroll the main review pane by line steps, viewport fractions, or whole-content jumps. */
  const scrollDiff = (
    delta: number,
    unit: "step" | "viewport" | "content" | "half" = "viewport",
  ) => {
    if (unit === "half") {
      const scrollBox = diffScrollRef.current;
      if (!scrollBox) return;

      // Calculate half the viewport height
      const viewportHeight = scrollBox.viewport?.height ?? 20;
      const scrollAmount = Math.floor(viewportHeight / 2);

      // Use scrollTo with current position + delta * amount
      const currentScroll = scrollBox.scrollTop;
      scrollBox.scrollTo(currentScroll + delta * scrollAmount);
      return;
    }
    diffScrollRef.current?.scrollBy(delta, unit);
  };

  const maxCodeHorizontalOffset = useMemo(
    () =>
      Math.max(
        0,
        filteredFiles.reduce(
          (maxWidth, file) => Math.max(maxWidth, maxFileCodeLineWidth(file)),
          0,
        ) - codeViewportWidth,
      ),
    [codeViewportWidth, filteredFiles],
  );

  useEffect(() => {
    setCodeHorizontalOffset((current) => clamp(current, 0, maxCodeHorizontalOffset));
  }, [maxCodeHorizontalOffset]);

  /** Shift the visible code columns horizontally without moving gutters or headers. */
  const scrollCodeHorizontally = useCallback(
    (delta: number) => {
      if (wrapLines || delta === 0 || maxCodeHorizontalOffset <= 0) {
        return;
      }

      setCodeHorizontalOffset((current) => clamp(current + delta, 0, maxCodeHorizontalOffset));
    },
    [maxCodeHorizontalOffset, wrapLines],
  );

  /** Preserve the current review position before changing the active diff layout. */
  const selectLayoutMode = useCallback((mode: LayoutMode) => {
    layoutToggleScrollTopRef.current = diffScrollRef.current?.scrollTop ?? 0;
    setLayoutToggleRequestId((current) => current + 1);
    setLayoutMode(mode);
  }, []);

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
    // Capture the pre-toggle viewport position synchronously so DiffPane can restore the same
    // top-most source row after wrapped row heights change.
    wrapToggleScrollTopRef.current = diffScrollRef.current?.scrollTop ?? 0;
    setCodeHorizontalOffset(0);
    setWrapLines((current) => !current);
  };

  /** Toggle the sidebar, forcing it open on narrower layouts when the app can still fit both panes. */
  const toggleSidebar = () => {
    if (sidebarVisible && (responsiveLayout.showSidebar || forceSidebarOpen)) {
      setSidebarVisible(false);
      setForceSidebarOpen(false);
      return;
    }

    if (sidebarVisible && !responsiveLayout.showSidebar) {
      if (canForceShowSidebar) {
        setForceSidebarOpen(true);
      }
      return;
    }

    setSidebarVisible(true);
    setForceSidebarOpen(!responsiveLayout.showSidebar && canForceShowSidebar);
  };

  /** Toggle visibility of hunk metadata rows without changing the actual diff lines. */
  const toggleHunkHeaders = () => {
    setShowHunkHeaders((current) => !current);
  };

  /** Jump to an annotated hunk without changing the global note visibility toggle. */
  const openAgentNotesAtHunk = useCallback(
    (fileId: string, hunkIndex: number) => {
      review.selectHunk(fileId, hunkIndex);
    },
    [review.selectHunk],
  );

  const canRefreshCurrentInput = canReloadInput(bootstrap.input);
  const watchEnabled = Boolean(bootstrap.input.options.watch && canRefreshCurrentInput);

  /** Rebuild the current diff source while preserving the active app view options. */
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

    await onReloadSession(nextInput, {
      resetApp: false,
      sourcePath:
        bootstrap.input.kind === "git" ||
        bootstrap.input.kind === "show" ||
        bootstrap.input.kind === "stash-show"
          ? bootstrap.changeset.sourceLabel
          : undefined,
    });
  }, [
    bootstrap.changeset.sourceLabel,
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

  /** Leave the app through the shared shutdown path. */
  const requestQuit = useCallback(() => {
    onQuit();
  }, [onQuit]);

  /** Close the modal keyboard help overlay. */
  const closeHelp = useCallback(() => {
    setShowHelp(false);
  }, []);

  /** Toggle the modal keyboard help overlay. */
  const toggleHelp = useCallback(() => {
    setShowHelp((current) => !current);
  }, []);

  /** Focus the file list/sidebar navigation area. */
  const focusFiles = useCallback(() => {
    setFocusArea("files");
  }, []);

  /** Focus the file filter input in the status bar. */
  const focusFilter = useCallback(() => {
    setFocusArea("filter");
  }, []);

  /** Toggle keyboard focus between the file list and the file filter. */
  const toggleFocusArea = useCallback(() => {
    setFocusArea((current) => (current === "files" ? "filter" : "files"));
  }, []);

  /** Cycle through the available built-in themes. */
  const cycleTheme = useCallback(() => {
    const currentIndex = THEMES.findIndex((theme) => theme.id === activeTheme.id);
    const nextIndex = (currentIndex + 1) % THEMES.length;
    setThemeId(THEMES[nextIndex]!.id);
  }, [activeTheme.id]);

  const menus = useMemo(
    () =>
      buildAppMenus({
        activeThemeId: activeTheme.id,
        canRefreshCurrentInput,
        focusFilter,
        layoutMode,
        moveToAnnotatedFile,
        moveToAnnotatedHunk,
        moveToHunk: review.moveToHunk,
        refreshCurrentInput: triggerRefreshCurrentInput,
        requestQuit,
        selectLayoutMode,
        selectThemeId: setThemeId,
        showAgentNotes,
        showHelp,
        showHunkHeaders,
        showLineNumbers,
        sidebarVisible,
        toggleAgentNotes,
        toggleFocusArea,
        toggleHelp,
        toggleHunkHeaders,
        toggleLineNumbers,
        toggleLineWrap,
        toggleSidebar,
        wrapLines,
      }),
    [
      activeTheme.id,
      canRefreshCurrentInput,
      focusFilter,
      layoutMode,
      moveToAnnotatedFile,
      moveToAnnotatedHunk,
      requestQuit,
      review.moveToHunk,
      selectLayoutMode,
      triggerRefreshCurrentInput,
      showAgentNotes,
      showHelp,
      showHunkHeaders,
      showLineNumbers,
      sidebarVisible,
      toggleAgentNotes,
      toggleFocusArea,
      toggleHelp,
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

  useAppKeyboardShortcuts({
    activeMenuId,
    activateCurrentMenuItem,
    canRefreshCurrentInput,
    closeHelp,
    closeMenu,
    cycleTheme,
    focusArea,
    focusFilter,
    moveToAnnotatedHunk,
    moveToHunk: review.moveToHunk,
    moveMenuItem,
    openMenu,
    pagerMode,
    requestQuit,
    scrollCodeHorizontally,
    scrollDiff,
    selectLayoutMode,
    showHelp,
    switchMenu,
    toggleAgentNotes,
    toggleFocusArea,
    toggleHelp,
    toggleHunkHeaders,
    toggleLineNumbers,
    toggleLineWrap,
    toggleSidebar,
    triggerRefreshCurrentInput,
  });

  /** Start a mouse drag resize for the optional sidebar. */
  const beginSidebarResize = (event: TuiMouseEvent) => {
    if (event.button !== MouseButton.LEFT) {
      return;
    }

    closeMenu();
    setResizeDragOriginX(event.x);
    setResizeStartWidth(clampedSidebarWidth);
    event.preventDefault();
    event.stopPropagation();
  };

  /** Update the sidebar width while a drag resize is active. */
  const updateSidebarResize = (event: TuiMouseEvent) => {
    if (!isResizingSidebar || resizeDragOriginX === null || resizeStartWidth === null) {
      return;
    }

    setSidebarWidth(
      resizeSidebarWidth(
        resizeStartWidth,
        resizeDragOriginX,
        event.x,
        SIDEBAR_MIN_WIDTH,
        maxSidebarWidth,
      ),
    );
    event.preventDefault();
    event.stopPropagation();
  };

  /** End the current sidebar resize interaction. */
  const endSidebarResize = (event?: TuiMouseEvent) => {
    if (!isResizingSidebar) {
      return;
    }

    setResizeDragOriginX(null);
    setResizeStartWidth(null);
    event?.preventDefault();
    event?.stopPropagation();
  };

  const totalAdditions = bootstrap.changeset.files.reduce(
    (sum, file) => sum + file.stats.additions,
    0,
  );
  const totalDeletions = bootstrap.changeset.files.reduce(
    (sum, file) => sum + file.stats.deletions,
    0,
  );
  const topTitle = `${bootstrap.changeset.title}  +${totalAdditions}  -${totalDeletions}`;
  const sidebarTextWidth = Math.max(8, clampedSidebarWidth - 2);
  const diffHeaderStatsWidth = Math.min(24, Math.max(16, Math.floor(diffContentWidth / 3)));
  const diffHeaderLabelWidth = Math.max(8, diffContentWidth - diffHeaderStatsWidth - 1);
  const diffSeparatorWidth = Math.max(4, diffContentWidth - 2);

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
        onMouseDrag={updateSidebarResize}
        onMouseDragEnd={endSidebarResize}
        onMouseUp={(event) => {
          endSidebarResize(event);
          closeMenu();
        }}
      >
        {renderSidebar ? (
          <>
            <SidebarPane
              entries={review.sidebarEntries}
              scrollRef={sidebarScrollRef}
              selectedFileId={selectedFile?.id}
              textWidth={sidebarTextWidth}
              theme={activeTheme}
              width={clampedSidebarWidth}
              onSelectFile={(fileId) => {
                focusFiles();
                jumpToFile(fileId, 0, { alignFileHeaderTop: true });
              }}
            />

            <PaneDivider
              dividerHitLeft={dividerHitLeft}
              dividerHitWidth={DIVIDER_HIT_WIDTH}
              isResizing={isResizingSidebar}
              theme={activeTheme}
              onMouseDown={beginSidebarResize}
              onMouseDrag={updateSidebarResize}
              onMouseDragEnd={endSidebarResize}
              onMouseUp={endSidebarResize}
            />
          </>
        ) : null}

        <DiffPane
          codeHorizontalOffset={codeHorizontalOffset}
          diffContentWidth={diffContentWidth}
          files={filteredFiles}
          pagerMode={pagerMode}
          headerLabelWidth={diffHeaderLabelWidth}
          headerStatsWidth={diffHeaderStatsWidth}
          layout={resolvedLayout}
          scrollRef={diffScrollRef}
          selectedFileId={selectedFile?.id}
          selectedHunkIndex={selectedHunkIndex}
          scrollToNote={review.scrollToNote}
          separatorWidth={diffSeparatorWidth}
          showAgentNotes={showAgentNotes}
          showLineNumbers={showLineNumbers}
          showHunkHeaders={showHunkHeaders}
          wrapLines={wrapLines}
          wrapToggleScrollTop={wrapToggleScrollTopRef.current}
          layoutToggleScrollTop={layoutToggleScrollTopRef.current}
          layoutToggleRequestId={layoutToggleRequestId}
          selectedFileTopAlignRequestId={review.selectedFileTopAlignRequestId}
          selectedHunkRevealRequestId={review.selectedHunkRevealRequestId}
          theme={activeTheme}
          width={diffPaneWidth}
          onOpenAgentNotesAtHunk={openAgentNotesAtHunk}
          onScrollCodeHorizontally={(delta) => {
            scrollCodeHorizontally(delta * FAST_CODE_HORIZONTAL_SCROLL_COLUMNS);
          }}
          onSelectFile={jumpToFile}
          onViewportCenteredHunkChange={(fileId, hunkIndex) =>
            review.selectHunk(fileId, hunkIndex, { preserveViewport: true })
          }
        />
      </box>

      {!pagerMode && (focusArea === "filter" || Boolean(review.filter) || Boolean(noticeText)) ? (
        <StatusBar
          filter={review.filter}
          filterFocused={focusArea === "filter"}
          noticeText={noticeText ?? undefined}
          terminalWidth={terminal.width}
          theme={activeTheme}
          onCloseMenu={closeMenu}
          onFilterInput={review.setFilter}
          onFilterSubmit={focusFiles}
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
            onClose={closeHelp}
          />
        </Suspense>
      ) : null}
    </box>
  );
}

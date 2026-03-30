import type { MouseEvent as TuiMouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { Suspense, lazy, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import type { AppBootstrap, CliInput } from "../core/types";
import type { UpdateNotice } from "../core/updateNotice";
import { HunkHostClient } from "../mcp/client";
import type { ReloadedSessionResult } from "../mcp/types";
import { MenuBar } from "./components/chrome/MenuBar";
import { StatusBar } from "./components/chrome/StatusBar";
import { DiffPane } from "./components/panes/DiffPane";
import { FilesPane } from "./components/panes/FilesPane";
import { PaneDivider } from "./components/panes/PaneDivider";
import { useAppLayout } from "./hooks/useAppLayout";
import { useCurrentInputRefresh } from "./hooks/useCurrentInputRefresh";
import { useHunkSessionBridge } from "./hooks/useHunkSessionBridge";
import { type FocusArea, useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useMenuState } from "./hooks/useMenuState";
import { useReloadableBootstrap } from "./hooks/useReloadableBootstrap";
import { useReviewNavigation } from "./hooks/useReviewNavigation";
import { useReviewSelectionState } from "./hooks/useReviewSelectionState";
import { useReviewSelectionSync } from "./hooks/useReviewSelectionSync";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { useStartupUpdateNotice } from "./hooks/useStartupUpdateNotice";
import { useViewPreferences } from "./hooks/useViewPreferences";
import { buildSidebarEntries, filterReviewFiles, mergeFileAnnotationsByFileId } from "./lib/files";

const LazyHelpDialog = lazy(async () => ({
  default: (await import("./components/chrome/HelpDialog")).HelpDialog,
}));
const LazyMenuDropdown = lazy(async () => ({
  default: (await import("./components/chrome/MenuDropdown")).MenuDropdown,
}));

const FILES_MIN_WIDTH = 22;
const DIFF_MIN_WIDTH = 48;
const BODY_PADDING = 2;
const DIVIDER_WIDTH = 1;
const DIVIDER_HIT_WIDTH = 5;

function AppShell({
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
    options?: { resetShell?: boolean; sourcePath?: string },
  ) => Promise<ReloadedSessionResult>;
}) {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const filesScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [focusArea, setFocusArea] = useState<FocusArea>("files");
  const [filter, setFilter] = useState("");
  const deferredFilter = useDeferredValue(filter);
  const pagerMode = Boolean(bootstrap.input.options.pager);

  const selection = useReviewSelectionState(bootstrap.changeset.files[0]?.id ?? "", filesScrollRef);
  const {
    activeTheme,
    forceSidebarOpen,
    layoutMode,
    setForceSidebarOpen,
    setLayoutMode,
    setShowAgentNotes,
    setSidebarVisible,
    setThemeId,
    showAgentNotes,
    showHunkHeaders,
    showLineNumbers,
    sidebarVisible,
    themeId,
    toggleAgentNotes,
    toggleHunkHeaders,
    toggleLineNumbers,
    toggleLineWrap: toggleViewLineWrap,
    toggleTheme,
    wrapLines,
    wrapToggleScrollTopRef,
  } = useViewPreferences(bootstrap, renderer.themeMode);

  const openAgentNotes = useCallback(() => setShowAgentNotes(true), [setShowAgentNotes]);
  const baseSelectedFile =
    bootstrap.changeset.files.find((file) => file.id === selection.selectedFileId) ??
    bootstrap.changeset.files[0];
  const { liveCommentsByFileId } = useHunkSessionBridge({
    currentHunk: baseSelectedFile?.metadata.hunks[selection.selectedHunkIndex],
    files: bootstrap.changeset.files,
    filterQuery: deferredFilter,
    hostClient,
    jumpToAnnotatedHunk: selection.jumpToAnnotatedHunk,
    jumpToFile: selection.jumpToFile,
    openAgentNotes,
    reloadSession: onReloadSession,
    selectedFile: baseSelectedFile,
    selectedHunkIndex: selection.selectedHunkIndex,
    showAgentNotes,
  });

  const mergedFiles = useMemo(
    () => mergeFileAnnotationsByFileId(bootstrap.changeset.files, liveCommentsByFileId),
    [bootstrap.changeset.files, liveCommentsByFileId],
  );
  const visibleFiles = useMemo(
    () => filterReviewFiles(mergedFiles, deferredFilter),
    [deferredFilter, mergedFiles],
  );
  const activeFile =
    visibleFiles.find((file) => file.id === selection.selectedFileId) ??
    mergedFiles.find((file) => file.id === selection.selectedFileId) ??
    visibleFiles[0];

  useReviewSelectionSync({
    activeFile,
    files: visibleFiles,
    filesScrollRef,
    setSelectedFileId: selection.setSelectedFileId,
    setSelectedHunkIndex: selection.setSelectedHunkIndex,
  });

  const navigation = useReviewNavigation({
    files: visibleFiles,
    jumpToAnnotatedHunk: selection.jumpToAnnotatedHunk,
    jumpToFile: selection.jumpToFile,
    selectedFileId: activeFile?.id,
    selectedHunkIndex: selection.selectedHunkIndex,
  });

  const {
    availableCenterWidth,
    bodyPadding,
    canForceShowFilesPane,
    maxFilesPaneWidth,
    responsiveLayout,
    showFilesPane,
  } = useAppLayout({
    bodyPadding: BODY_PADDING,
    diffMinWidth: DIFF_MIN_WIDTH,
    filesMinWidth: FILES_MIN_WIDTH,
    forceSidebarOpen,
    layoutMode,
    pagerMode,
    renderer,
    sidebarVisible,
    terminalHeight: terminal.height,
    terminalWidth: terminal.width,
    wrapLines,
  });
  const {
    beginFilesPaneResize: beginSidebarResize,
    clampedFilesPaneWidth,
    endFilesPaneResize,
    isResizingFilesPane,
    updateFilesPaneResize,
  } = useSidebarResize({
    maxWidth: maxFilesPaneWidth,
    minWidth: FILES_MIN_WIDTH,
    showPane: showFilesPane,
  });
  const diffPaneWidth = showFilesPane
    ? Math.max(DIFF_MIN_WIDTH, availableCenterWidth - clampedFilesPaneWidth)
    : availableCenterWidth;
  const dividerHitLeft = Math.max(
    1,
    1 + clampedFilesPaneWidth - Math.floor((DIVIDER_HIT_WIDTH - DIVIDER_WIDTH) / 2),
  );

  const scrollDiff = useCallback(
    (delta: number, unit: "step" | "viewport" | "content" | "half" = "viewport") => {
      if (unit === "half") {
        const scrollBox = diffScrollRef.current;
        if (!scrollBox) return;
        const viewportHeight = scrollBox.viewport?.height ?? 20;
        scrollBox.scrollTo(scrollBox.scrollTop + delta * Math.floor(viewportHeight / 2));
        return;
      }
      diffScrollRef.current?.scrollBy(delta, unit);
    },
    [],
  );

  const toggleLineWrap = useCallback(() => {
    toggleViewLineWrap(diffScrollRef.current?.scrollTop ?? 0);
  }, [toggleViewLineWrap]);
  const toggleSidebar = useCallback(() => {
    if (sidebarVisible && (responsiveLayout.showFilesPane || forceSidebarOpen)) {
      setSidebarVisible(false);
      setForceSidebarOpen(false);
      return;
    }
    if (sidebarVisible && !responsiveLayout.showFilesPane) {
      if (canForceShowFilesPane) setForceSidebarOpen(true);
      return;
    }
    setSidebarVisible(true);
    setForceSidebarOpen(!responsiveLayout.showFilesPane && canForceShowFilesPane);
  }, [
    canForceShowFilesPane,
    forceSidebarOpen,
    responsiveLayout.showFilesPane,
    setForceSidebarOpen,
    setSidebarVisible,
    sidebarVisible,
  ]);

  const { canRefreshCurrentInput, triggerRefreshCurrentInput } = useCurrentInputRefresh({
    bootstrap,
    layoutMode,
    onReloadSession,
    showAgentNotes,
    showHunkHeaders,
    showLineNumbers,
    themeId,
    wrapLines,
  });

  const requestQuit = useCallback(() => onQuit(), [onQuit]);
  const toggleHelp = useCallback(() => setShowHelp((current) => !current), []);
  const toggleFocusArea = useCallback(
    () => setFocusArea((current) => (current === "files" ? "filter" : "files")),
    [],
  );
  const menu = useMenuState({
    activeThemeId: activeTheme.id,
    canRefreshCurrentInput,
    focusFilter: () => setFocusArea("filter"),
    layoutMode,
    moveAnnotatedFile: navigation.moveAnnotatedFile,
    moveAnnotatedHunk: navigation.moveAnnotatedHunk,
    moveHunk: navigation.moveHunk,
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
    toggleFocusArea,
    toggleHelp,
    toggleHunkHeaders,
    toggleLineNumbers,
    toggleLineWrap,
    toggleSidebar,
    wrapLines,
  });

  const beginFilesPaneResize = useCallback(
    (event: TuiMouseEvent) => {
      menu.closeMenu();
      beginSidebarResize(event);
    },
    [beginSidebarResize, menu.closeMenu],
  );

  useKeyboardShortcuts({
    activeMenuId: menu.activeMenuId,
    canRefreshCurrentInput,
    filter,
    focusArea,
    pagerMode,
    showHelp,
    onActivateMenuItem: menu.activateCurrentMenuItem,
    onCloseMenu: menu.closeMenu,
    onMoveAnnotatedHunk: navigation.moveAnnotatedHunk,
    onMoveHunk: navigation.moveHunk,
    onMoveMenuItem: menu.moveMenuItem,
    onOpenMenu: menu.openMenu,
    onQuit: requestQuit,
    onRefreshCurrentInput: triggerRefreshCurrentInput,
    onScrollDiff: scrollDiff,
    onSetFilter: setFilter,
    onSetFocusArea: setFocusArea,
    onSetLayoutMode: setLayoutMode,
    onSwitchMenu: menu.switchMenu,
    onToggleAgentNotes: toggleAgentNotes,
    onToggleFocusArea: toggleFocusArea,
    onToggleHelp: toggleHelp,
    onToggleHunkHeaders: toggleHunkHeaders,
    onToggleLineNumbers: toggleLineNumbers,
    onToggleLineWrap: toggleLineWrap,
    onToggleSidebar: toggleSidebar,
    onToggleTheme: toggleTheme,
  });

  const fileEntries = buildSidebarEntries(visibleFiles);
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
          activeMenuId={menu.activeMenuId}
          menuSpecs={menu.menuSpecs}
          terminalWidth={terminal.width}
          theme={activeTheme}
          topTitle={topTitle}
          onHoverMenu={(menuId) => {
            if (menu.activeMenuId) menu.openMenu(menuId);
          }}
          onToggleMenu={menu.toggleMenu}
        />
      ) : null}

      <box
        style={{
          flexGrow: 1,
          flexDirection: "row",
          gap: 0,
          paddingLeft: bodyPadding / 2,
          paddingRight: bodyPadding / 2,
          position: "relative",
        }}
        onMouseDrag={updateFilesPaneResize}
        onMouseDragEnd={endFilesPaneResize}
        onMouseUp={(event) => {
          endFilesPaneResize(event);
          menu.closeMenu();
        }}
      >
        {showFilesPane ? (
          <>
            <FilesPane
              entries={fileEntries}
              scrollRef={filesScrollRef}
              selectedFileId={activeFile?.id}
              textWidth={filesTextWidth}
              theme={activeTheme}
              width={clampedFilesPaneWidth}
              onSelectFile={(fileId) => {
                setFocusArea("files");
                selection.jumpToFile(fileId);
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
          files={visibleFiles}
          pagerMode={pagerMode}
          headerLabelWidth={diffHeaderLabelWidth}
          headerStatsWidth={diffHeaderStatsWidth}
          layout={responsiveLayout.layout}
          scrollRef={diffScrollRef}
          scrollToNote={selection.scrollToNote}
          selectedFileId={activeFile?.id}
          selectedHunkIndex={selection.selectedHunkIndex}
          separatorWidth={diffSeparatorWidth}
          showAgentNotes={showAgentNotes}
          showHunkHeaders={showHunkHeaders}
          showLineNumbers={showLineNumbers}
          theme={activeTheme}
          width={diffPaneWidth}
          wrapLines={wrapLines}
          wrapToggleScrollTop={wrapToggleScrollTopRef.current}
          onOpenAgentNotesAtHunk={navigation.openAgentNotesAtHunk}
          onSelectFile={selection.jumpToFile}
        />
      </box>

      {!pagerMode && (focusArea === "filter" || Boolean(filter) || Boolean(noticeText)) ? (
        <StatusBar
          filter={filter}
          filterFocused={focusArea === "filter"}
          noticeText={noticeText ?? undefined}
          terminalWidth={terminal.width}
          theme={activeTheme}
          onCloseMenu={menu.closeMenu}
          onFilterInput={setFilter}
          onFilterSubmit={() => setFocusArea("files")}
        />
      ) : null}

      {!pagerMode && menu.activeMenuId && menu.activeMenuSpec ? (
        <Suspense fallback={null}>
          <LazyMenuDropdown
            activeMenuEntries={menu.activeMenuEntries}
            activeMenuId={menu.activeMenuId}
            activeMenuItemIndex={menu.activeMenuItemIndex}
            activeMenuSpec={menu.activeMenuSpec}
            activeMenuWidth={menu.activeMenuWidth}
            terminalWidth={terminal.width}
            theme={activeTheme}
            onHoverItem={menu.setActiveMenuItemIndex}
            onSelectItem={(entry) => {
              entry.action();
              menu.closeMenu();
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

export function App({
  bootstrap,
  hostClient,
  onQuit = () => process.exit(0),
  startupNoticeResolver,
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkHostClient;
  onQuit?: () => void;
  startupNoticeResolver?: () => Promise<UpdateNotice | null>;
}) {
  const { activeBootstrap, reloadSession, shellVersion } = useReloadableBootstrap(
    bootstrap,
    hostClient,
  );
  const startupNoticeText = useStartupUpdateNotice({
    enabled: !bootstrap.input.options.pager,
    resolver: startupNoticeResolver,
  });

  return (
    <AppShell
      key={shellVersion}
      bootstrap={activeBootstrap}
      hostClient={hostClient}
      noticeText={startupNoticeText}
      onQuit={onQuit}
      onReloadSession={reloadSession}
    />
  );
}

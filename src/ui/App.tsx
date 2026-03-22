import { MouseButton, type KeyEvent, type MouseEvent as TuiMouseEvent, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { Suspense, lazy, startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import type { AppBootstrap, LayoutMode } from "../core/types";
import { MenuBar } from "./components/chrome/MenuBar";
import { MENU_ORDER, buildMenuSpecs, menuWidth, nextMenuItemIndex, type MenuEntry, type MenuId } from "./components/chrome/menu";
import { StatusBar } from "./components/chrome/StatusBar";
import { DiffPane } from "./components/panes/DiffPane";
import { FilesPane } from "./components/panes/FilesPane";
import { PaneDivider } from "./components/panes/PaneDivider";
import { getSelectedAnnotations } from "./lib/agentAnnotations";
import { buildFileListEntry } from "./lib/files";
import { buildHunkCursors, findNextHunkCursor } from "./lib/hunks";
import { diffHunkId, diffSectionId, fileRowId } from "./lib/ids";
import { resolveResponsiveLayout } from "./lib/responsive";
import { resizeSidebarWidth } from "./lib/sidebar";
import { resolveTheme, THEMES } from "./themes";

type FocusArea = "files" | "filter";

const LazyHelpDialog = lazy(async () => ({ default: (await import("./components/chrome/HelpDialog")).HelpDialog }));
const LazyMenuDropdown = lazy(async () => ({ default: (await import("./components/chrome/MenuDropdown")).MenuDropdown }));

/** Clamp a value into an inclusive range. */
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Orchestrate global app state, layout, navigation, and pane coordination. */
export function App({
  bootstrap,
  onQuit = () => process.exit(0),
}: {
  bootstrap: AppBootstrap;
  onQuit?: () => void;
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
  const [themeId, setThemeId] = useState(() => resolveTheme(bootstrap.initialTheme, renderer.themeMode).id);
  const [showAgentNotes, setShowAgentNotes] = useState(bootstrap.initialShowAgentNotes ?? false);
  const [showLineNumbers, setShowLineNumbers] = useState(bootstrap.initialShowLineNumbers ?? true);
  const [wrapLines, setWrapLines] = useState(bootstrap.initialWrapLines ?? false);
  const [showHunkHeaders, setShowHunkHeaders] = useState(bootstrap.initialShowHunkHeaders ?? true);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [focusArea, setFocusArea] = useState<FocusArea>("files");
  const [activeMenuId, setActiveMenuId] = useState<MenuId | null>(null);
  const [activeMenuItemIndex, setActiveMenuItemIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [filesPaneWidth, setFilesPaneWidth] = useState(34);
  const [resizeDragOriginX, setResizeDragOriginX] = useState<number | null>(null);
  const [resizeStartWidth, setResizeStartWidth] = useState<number | null>(null);
  const [dismissedAgentNoteIds, setDismissedAgentNoteIds] = useState<string[]>([]);
  const [selectedFileId, setSelectedFileId] = useState(bootstrap.changeset.files[0]?.id ?? "");
  const [selectedHunkIndex, setSelectedHunkIndex] = useState(0);
  const deferredFilter = useDeferredValue(filter);

  const pagerMode = Boolean(bootstrap.input.options.pager);
  const activeTheme = resolveTheme(themeId, renderer.themeMode);

  const filteredFiles = bootstrap.changeset.files.filter((file) => {
    if (!deferredFilter.trim()) {
      return true;
    }

    const haystack = [file.path, file.previousPath, file.agent?.summary].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(deferredFilter.trim().toLowerCase());
  });

  const selectedFile =
    filteredFiles.find((file) => file.id === selectedFileId) ??
    bootstrap.changeset.files.find((file) => file.id === selectedFileId) ??
    filteredFiles[0];
  const hunkCursors = buildHunkCursors(filteredFiles);

  const bodyPadding = pagerMode ? 0 : BODY_PADDING;
  const bodyWidth = Math.max(0, terminal.width - bodyPadding);
  const responsiveLayout = resolveResponsiveLayout(layoutMode, terminal.width);
  const showFilesPane = pagerMode ? false : responsiveLayout.showFilesPane && sidebarVisible;
  const centerWidth = bodyWidth;
  const resolvedLayout = responsiveLayout.layout;
  const currentHunk = selectedFile?.metadata.hunks[selectedHunkIndex];
  const activeAnnotations = getSelectedAnnotations(selectedFile, currentHunk);
  const availableCenterWidth = showFilesPane ? Math.max(0, centerWidth - DIVIDER_WIDTH) : Math.max(0, centerWidth);
  const maxFilesPaneWidth = showFilesPane ? Math.max(FILES_MIN_WIDTH, availableCenterWidth - DIFF_MIN_WIDTH) : FILES_MIN_WIDTH;
  const clampedFilesPaneWidth = showFilesPane ? clamp(filesPaneWidth, FILES_MIN_WIDTH, maxFilesPaneWidth) : 0;
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

    if (selectedFile && !filteredFiles.some((file) => file.id === selectedFile.id) && filteredFiles[0]) {
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

  useEffect(() => {
    // Dismissed notes are hunk-local, so reset them when the review focus moves.
    setDismissedAgentNoteIds([]);
  }, [selectedFile?.id, selectedHunkIndex]);

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

  /** Jump the review stream to a file and optionally a specific hunk within it. */
  const jumpToFile = (fileId: string, nextHunkIndex = 0) => {
    filesScrollRef.current?.scrollChildIntoView(fileRowId(fileId));
    setSelectedFileId(fileId);
    setSelectedHunkIndex(nextHunkIndex);
  };

  /** Scroll the main review pane by a viewport fraction or whole-content jump. */
  const scrollDiff = (delta: number, unit: "viewport" | "content" = "viewport") => {
    diffScrollRef.current?.scrollBy(delta, unit);
  };

  /** Move file selection within the currently filtered sidebar list. */
  const moveFile = (delta: number) => {
    if (filteredFiles.length === 0 || !selectedFile) {
      return;
    }

    const currentIndex = filteredFiles.findIndex((file) => file.id === selectedFile.id);
    const nextIndex = clamp(currentIndex + delta, 0, filteredFiles.length - 1);
    const nextFile = filteredFiles[nextIndex];
    if (!nextFile) {
      return;
    }

    jumpToFile(nextFile.id);
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

  /** Close any open top-level menu. */
  const closeMenu = () => {
    setActiveMenuId(null);
  };

  /** Show agent notes and clear any per-hunk dismissals. */
  const openAgentNotes = () => {
    setDismissedAgentNoteIds([]);
    setShowAgentNotes(true);
  };

  /** Toggle the note layer while keeping dismissals scoped to the visible hunk. */
  const toggleAgentNotes = () => {
    if (showAgentNotes) {
      setShowAgentNotes(false);
      setDismissedAgentNoteIds([]);
      return;
    }

    openAgentNotes();
  };

  /** Hide one visible note card until the selection changes. */
  const dismissAgentNote = (noteId: string) => {
    setDismissedAgentNoteIds((current) => [...current, noteId]);
  };

  /** Toggle line-number gutters without changing the diff content itself. */
  const toggleLineNumbers = () => {
    setShowLineNumbers((current) => !current);
  };

  /** Toggle whether diff code rows wrap instead of truncating to one terminal row. */
  const toggleLineWrap = () => {
    setWrapLines((current) => !current);
  };

  /** Toggle sidebar visibility independently of layout mode. */
  const toggleSidebar = () => {
    setSidebarVisible((current) => !current);
  };

  /** Toggle visibility of hunk metadata rows without changing the actual diff lines. */
  const toggleHunkHeaders = () => {
    setShowHunkHeaders((current) => !current);
  };

  /** Jump to the annotated hunk before opening the note layer. */
  const openAgentNotesAtHunk = (fileId: string, hunkIndex: number) => {
    jumpToFile(fileId, hunkIndex);
    openAgentNotes();
  };

  /** Leave the app through the shell-owned shutdown path. */
  const requestQuit = () => {
    onQuit();
  };

  /** Start a mouse drag resize for the optional files pane. */
  const beginFilesPaneResize = (event: TuiMouseEvent) => {
    if (event.button !== MouseButton.LEFT) {
      return;
    }

    setActiveMenuId(null);
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
      resizeSidebarWidth(resizeStartWidth, resizeDragOriginX, event.x, FILES_MIN_WIDTH, maxFilesPaneWidth),
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

  const themeMenuEntries: MenuEntry[] = THEMES.map((theme) => ({
    kind: "item",
    label: theme.label,
    checked: theme.id === activeTheme.id,
    action: () => {
      setThemeId(theme.id);
    },
  }));

  const menus: Record<MenuId, MenuEntry[]> = {
    file: [
      {
        kind: "item",
        label: "Focus files",
        hint: "Tab",
        action: () => setFocusArea("files"),
      },
      {
        kind: "item",
        label: "Focus filter",
        hint: "/",
        action: () => setFocusArea("filter"),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Quit",
        hint: "q",
        action: requestQuit,
      },
    ],
    view: [
      {
        kind: "item",
        label: "Split view",
        hint: "1",
        checked: layoutMode === "split",
        action: () => setLayoutMode("split"),
      },
      {
        kind: "item",
        label: "Stacked view",
        hint: "2",
        checked: layoutMode === "stack",
        action: () => setLayoutMode("stack"),
      },
      {
        kind: "item",
        label: "Auto layout",
        hint: "0",
        checked: layoutMode === "auto",
        action: () => setLayoutMode("auto"),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Sidebar",
        hint: "s",
        checked: sidebarVisible,
        action: toggleSidebar,
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Agent notes",
        hint: "a",
        checked: showAgentNotes,
        action: toggleAgentNotes,
      },
      {
        kind: "item",
        label: "Line numbers",
        hint: "l",
        checked: showLineNumbers,
        action: toggleLineNumbers,
      },
      {
        kind: "item",
        label: "Line wrapping",
        hint: "w",
        checked: wrapLines,
        action: toggleLineWrap,
      },
      {
        kind: "item",
        label: "Hunk metadata",
        hint: "m",
        checked: showHunkHeaders,
        action: toggleHunkHeaders,
      },
    ],
    navigate: [
      {
        kind: "item",
        label: "Previous hunk",
        hint: "[",
        action: () => moveHunk(-1),
      },
      {
        kind: "item",
        label: "Next hunk",
        hint: "]",
        action: () => moveHunk(1),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Focus filter",
        hint: "/",
        action: () => setFocusArea("filter"),
      },
    ],
    theme: themeMenuEntries,
    agent: [
      {
        kind: "item",
        label: "Agent notes",
        hint: "a",
        checked: showAgentNotes,
        action: toggleAgentNotes,
      },
      {
        kind: "item",
        label: "Next annotated file",
        action: () => moveAnnotatedFile(1),
      },
      {
        kind: "item",
        label: "Previous annotated file",
        action: () => moveAnnotatedFile(-1),
      },
    ],
    help: [
      {
        kind: "item",
        label: "Keyboard help",
        hint: "?",
        checked: showHelp,
        action: () => setShowHelp((current) => !current),
      },
    ],
  };

  /** Open a menu and select its first actionable entry. */
  const openMenu = (menuId: MenuId) => {
    setActiveMenuId(menuId);
    setActiveMenuItemIndex(nextMenuItemIndex(menus[menuId], -1, 1));
  };

  /** Toggle a menu open/closed from the menu bar. */
  const toggleMenu = (menuId: MenuId) => {
    if (activeMenuId === menuId) {
      closeMenu();
      return;
    }

    openMenu(menuId);
  };

  /** Move horizontally across top-level menus. */
  const switchMenu = (delta: number) => {
    const currentIndex = Math.max(0, activeMenuId ? MENU_ORDER.indexOf(activeMenuId) : 0);
    const nextIndex = (currentIndex + delta + MENU_ORDER.length) % MENU_ORDER.length;
    openMenu(MENU_ORDER[nextIndex]!);
  };

  /** Invoke the currently highlighted menu item, if any. */
  const activateCurrentMenuItem = () => {
    if (!activeMenuId) {
      return;
    }

    const entry = menus[activeMenuId][activeMenuItemIndex];
    if (!entry || entry.kind !== "item") {
      return;
    }

    entry.action();
    closeMenu();
  };

  const menuSpecs = buildMenuSpecs();
  const fileEntries = filteredFiles.map(buildFileListEntry);
  const totalAdditions = bootstrap.changeset.files.reduce((sum, file) => sum + file.stats.additions, 0);
  const totalDeletions = bootstrap.changeset.files.reduce((sum, file) => sum + file.stats.deletions, 0);
  const activeMenuEntries = activeMenuId ? menus[activeMenuId] : [];
  const activeMenuSpec = menuSpecs.find((menu) => menu.id === activeMenuId);
  const activeMenuWidth = menuWidth(activeMenuEntries) + 2;
  const topTitle = `${bootstrap.changeset.title}  +${totalAdditions}  -${totalDeletions}`;
  const helpWidth = Math.min(68, Math.max(44, terminal.width - 8));
  const helpLeft = Math.max(1, Math.floor((terminal.width - helpWidth) / 2));
  const filesTextWidth = Math.max(8, clampedFilesPaneWidth - 4);
  const diffContentWidth = Math.max(12, diffPaneWidth - 2);
  const diffHeaderStatsWidth = Math.min(24, Math.max(16, Math.floor(diffContentWidth / 3)));
  const diffHeaderLabelWidth = Math.max(8, diffContentWidth - diffHeaderStatsWidth - 1);
  const diffSeparatorWidth = Math.max(4, diffContentWidth - 2);

  useKeyboard((key: KeyEvent) => {
    const pageDownKey = key.name === "pagedown" || key.name === "space" || key.name === " " || key.sequence === " ";
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
        scrollDiff(1 / 5, "viewport");
        return;
      }

      if (stepUpKey) {
        scrollDiff(-1 / 5, "viewport");
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
        setActiveMenuItemIndex((current) => nextMenuItemIndex(activeMenuEntries, current, -1));
        return;
      }

      if (key.name === "down") {
        setActiveMenuItemIndex((current) => nextMenuItemIndex(activeMenuEntries, current, 1));
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

    if (focusArea === "files" && key.name === "up") {
      moveFile(-1);
      return;
    }

    if (focusArea === "files" && key.name === "down") {
      moveFile(1);
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
              focused={focusArea === "files"}
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
          activeAnnotations={activeAnnotations}
          diffContentWidth={diffContentWidth}
          dismissedAgentNoteIds={dismissedAgentNoteIds}
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
          onDismissAgentNote={dismissAgentNote}
          onOpenAgentNotesAtHunk={openAgentNotesAtHunk}
          onSelectFile={jumpToFile}
        />
      </box>

      {!pagerMode ? (
        <StatusBar
          canResizeDivider={showFilesPane}
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
          <LazyHelpDialog left={helpLeft} theme={activeTheme} width={helpWidth} onClose={() => setShowHelp(false)} />
        </Suspense>
      ) : null}
    </box>
  );
}

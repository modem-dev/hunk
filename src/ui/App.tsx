import { MouseButton, type KeyEvent, type MouseEvent as TuiMouseEvent, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { Hunk } from "@pierre/diffs";
import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import type { AppBootstrap, DiffFile, LayoutMode } from "../core/types";
import { HelpDialog } from "./components/chrome/HelpDialog";
import { MenuBar } from "./components/chrome/MenuBar";
import { MenuDropdown } from "./components/chrome/MenuDropdown";
import { MENU_ORDER, buildMenuSpecs, menuWidth, nextMenuItemIndex, type MenuEntry, type MenuId } from "./components/chrome/menu";
import { StatusBar } from "./components/chrome/StatusBar";
import { AgentRail } from "./components/panes/AgentRail";
import { DiffPane } from "./components/panes/DiffPane";
import { FilesPane } from "./components/panes/FilesPane";
import { PaneDivider } from "./components/panes/PaneDivider";
import { buildFileListEntry } from "./lib/files";
import { diffSectionId, fileRowId } from "./lib/ids";
import { resolveResponsiveLayout, resolveResponsiveViewport } from "./lib/responsive";
import { resolveTheme, THEMES } from "./themes";

type FocusArea = "files" | "filter";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function overlap(rangeA: [number, number], rangeB: [number, number]) {
  return rangeA[0] <= rangeB[1] && rangeB[0] <= rangeA[1];
}

function hunkLineRange(hunk: Hunk) {
  const newEnd = Math.max(hunk.additionStart, hunk.additionStart + Math.max(hunk.additionLines, 1) - 1);
  const oldEnd = Math.max(hunk.deletionStart, hunk.deletionStart + Math.max(hunk.deletionLines, 1) - 1);

  return {
    oldRange: [hunk.deletionStart, oldEnd] as [number, number],
    newRange: [hunk.additionStart, newEnd] as [number, number],
  };
}

function getSelectedAnnotations(file: DiffFile | undefined, hunk: Hunk | undefined) {
  if (!file?.agent) {
    return [];
  }

  if (!hunk) {
    return file.agent.annotations;
  }

  const hunkRange = hunkLineRange(hunk);

  return file.agent.annotations.filter((annotation) => {
    if (annotation.newRange && overlap(annotation.newRange, hunkRange.newRange)) {
      return true;
    }

    if (annotation.oldRange && overlap(annotation.oldRange, hunkRange.oldRange)) {
      return true;
    }

    return false;
  });
}

export function App({ bootstrap }: { bootstrap: AppBootstrap }) {
  const FILES_MIN_WIDTH = 22;
  const DIFF_MIN_WIDTH = 48;
  const AGENT_WIDTH = 38;
  const AGENT_GAP = 1;
  const BODY_PADDING = 2;
  const DIVIDER_WIDTH = 1;
  const DIVIDER_HIT_WIDTH = 5;

  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const filesScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(bootstrap.initialMode);
  const [themeId, setThemeId] = useState(() => resolveTheme(bootstrap.initialTheme, renderer.themeMode).id);
  const [showAgentPanel, setShowAgentPanel] = useState(
    () => Boolean(bootstrap.changeset.agentSummary) || bootstrap.changeset.files.some((file) => file.agent),
  );
  const [showHelp, setShowHelp] = useState(false);
  const [focusArea, setFocusArea] = useState<FocusArea>("files");
  const [activeMenuId, setActiveMenuId] = useState<MenuId | null>(null);
  const [activeMenuItemIndex, setActiveMenuItemIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [filesPaneWidth, setFilesPaneWidth] = useState(34);
  const [resizeDragOriginX, setResizeDragOriginX] = useState<number | null>(null);
  const [resizeStartWidth, setResizeStartWidth] = useState<number | null>(null);
  const [selectedFileId, setSelectedFileId] = useState(bootstrap.changeset.files[0]?.id ?? "");
  const [selectedHunkIndex, setSelectedHunkIndex] = useState(0);
  const deferredFilter = useDeferredValue(filter);

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

  const bodyWidth = Math.max(0, terminal.width - BODY_PADDING);
  const shellViewport = resolveResponsiveViewport(bodyWidth, FILES_MIN_WIDTH, DIFF_MIN_WIDTH, DIVIDER_WIDTH);
  const effectiveShowAgentPanel =
    showAgentPanel &&
    shellViewport === "full" &&
    bodyWidth >= FILES_MIN_WIDTH + DIVIDER_WIDTH + DIFF_MIN_WIDTH + AGENT_GAP + AGENT_WIDTH;
  const centerWidth = Math.max(0, bodyWidth - (effectiveShowAgentPanel ? AGENT_WIDTH + AGENT_GAP : 0));
  const responsiveLayout = resolveResponsiveLayout(layoutMode, centerWidth, FILES_MIN_WIDTH, DIFF_MIN_WIDTH, DIVIDER_WIDTH);
  const resolvedLayout = responsiveLayout.layout;
  const showFilesPane = responsiveLayout.showFilesPane;
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
    renderer.intermediateRender();
  }, [effectiveShowAgentPanel, renderer, resolvedLayout, showFilesPane, terminal.height, terminal.width]);

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
    diffScrollRef.current?.scrollChildIntoView(diffSectionId(selectedFile.id));
  }, [selectedFile]);

  const moveHunk = (delta: number) => {
    if (!selectedFile || selectedFile.metadata.hunks.length === 0) {
      return;
    }

    setSelectedHunkIndex((current) => clamp(current + delta, 0, selectedFile.metadata.hunks.length - 1));
  };

  const jumpToFile = (fileId: string, nextHunkIndex = 0) => {
    filesScrollRef.current?.scrollChildIntoView(fileRowId(fileId));
    diffScrollRef.current?.scrollChildIntoView(diffSectionId(fileId));

    startTransition(() => {
      setSelectedFileId(fileId);
      setSelectedHunkIndex(nextHunkIndex);
    });
  };

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

  const closeMenu = () => {
    setActiveMenuId(null);
  };

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

  const updateFilesPaneResize = (event: TuiMouseEvent) => {
    if (!isResizingFilesPane || resizeDragOriginX === null || resizeStartWidth === null) {
      return;
    }

    const nextWidth = resizeStartWidth + (event.x - resizeDragOriginX);
    setFilesPaneWidth(clamp(nextWidth, FILES_MIN_WIDTH, maxFilesPaneWidth));
    event.preventDefault();
    event.stopPropagation();
  };

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
        action: () => process.exit(0),
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
        label: "Agent rail",
        hint: "a",
        checked: showAgentPanel,
        action: () => setShowAgentPanel((current) => !current),
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
      {
        kind: "item",
        label: "Previous file",
        hint: "k",
        action: () => moveFile(-1),
      },
      {
        kind: "item",
        label: "Next file",
        hint: "j",
        action: () => moveFile(1),
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
        label: "Agent rail",
        hint: "a",
        checked: showAgentPanel,
        action: () => setShowAgentPanel((current) => !current),
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

  const openMenu = (menuId: MenuId) => {
    setActiveMenuId(menuId);
    setActiveMenuItemIndex(nextMenuItemIndex(menus[menuId], -1, 1));
  };

  const toggleMenu = (menuId: MenuId) => {
    if (activeMenuId === menuId) {
      closeMenu();
      return;
    }

    openMenu(menuId);
  };

  const switchMenu = (delta: number) => {
    const currentIndex = Math.max(0, activeMenuId ? MENU_ORDER.indexOf(activeMenuId) : 0);
    const nextIndex = (currentIndex + delta + MENU_ORDER.length) % MENU_ORDER.length;
    openMenu(MENU_ORDER[nextIndex]!);
  };

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
    if (key.name === "f10") {
      if (activeMenuId) {
        closeMenu();
      } else {
        openMenu("file");
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

    if (key.name === "q") {
      process.exit(0);
    }

    if (key.name === "?") {
      setShowHelp((current) => !current);
      closeMenu();
      return;
    }

    if (key.name === "escape") {
      if (focusArea === "filter" && filter.length > 0) {
        setFilter("");
        return;
      }

      if (focusArea === "filter") {
        setFocusArea("files");
        return;
      }

      process.exit(0);
    }

    if (key.name === "tab") {
      setFocusArea((current) => (current === "files" ? "filter" : "files"));
      return;
    }

    if (key.name === "/") {
      setFocusArea("filter");
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

    if (key.name === "t") {
      const currentIndex = THEMES.findIndex((theme) => theme.id === activeTheme.id);
      const nextIndex = (currentIndex + 1) % THEMES.length;
      setThemeId(THEMES[nextIndex]!.id);
      closeMenu();
      return;
    }

    if (key.name === "a") {
      setShowAgentPanel((current) => !current);
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

    if (key.name === "j") {
      moveFile(1);
      closeMenu();
      return;
    }

    if (key.name === "k") {
      moveFile(-1);
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

      <box
        style={{ flexGrow: 1, flexDirection: "row", gap: 0, padding: 1, position: "relative" }}
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
          diffContentWidth={diffContentWidth}
          files={filteredFiles}
          headerLabelWidth={diffHeaderLabelWidth}
          headerStatsWidth={diffHeaderStatsWidth}
          layout={resolvedLayout}
          scrollRef={diffScrollRef}
          selectedFileId={selectedFile?.id}
          selectedHunkIndex={selectedHunkIndex}
          separatorWidth={diffSeparatorWidth}
          theme={activeTheme}
          width={diffPaneWidth}
          onSelectFile={jumpToFile}
        />

        {effectiveShowAgentPanel ? (
          <AgentRail
            activeAnnotations={activeAnnotations}
            changesetSummary={bootstrap.changeset.summary}
            file={selectedFile}
            marginLeft={AGENT_GAP}
            summary={bootstrap.changeset.agentSummary}
            theme={activeTheme}
            width={AGENT_WIDTH}
          />
        ) : null}
      </box>

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

      {activeMenuId && activeMenuSpec ? (
        <MenuDropdown
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
      ) : null}

      {showHelp ? <HelpDialog left={helpLeft} theme={activeTheme} width={helpWidth} onClose={() => setShowHelp(false)} /> : null}
    </box>
  );
}

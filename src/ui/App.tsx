import { MouseButton, type KeyEvent, type MouseEvent as TuiMouseEvent, type SelectOption } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { Hunk } from "@pierre/diffs";
import { startTransition, useDeferredValue, useEffect, useState } from "react";
import type { AppBootstrap, DiffFile, LayoutMode } from "../core/types";
import { PierreDiffView } from "./PierreDiffView";
import { resolveTheme, THEMES, type AppTheme } from "./themes";

type FocusArea = "files" | "filter";
type MenuId = "file" | "view" | "navigate" | "theme" | "agent" | "help";

type MenuEntry =
  | {
      kind: "item";
      label: string;
      hint?: string;
      checked?: boolean;
      action: () => void;
    }
  | {
      kind: "separator";
    };

const MENU_LABELS: Record<MenuId, string> = {
  file: "File",
  view: "View",
  navigate: "Navigate",
  theme: "Theme",
  agent: "Agent",
  help: "Help",
};

const MENU_ORDER = Object.keys(MENU_LABELS) as MenuId[];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function overlap(rangeA: [number, number], rangeB: [number, number]) {
  return rangeA[0] <= rangeB[1] && rangeB[0] <= rangeA[1];
}

function fitText(text: string, width: number) {
  if (width <= 0) {
    return "";
  }

  if (text.length <= width) {
    return text;
  }

  if (width === 1) {
    return ".";
  }

  return `${text.slice(0, width - 1)}.`;
}

function padText(text: string, width: number) {
  const trimmed = fitText(text, width);
  return trimmed.padEnd(width, " ");
}

function buildFileOption(file: DiffFile): SelectOption {
  const prefix =
    file.metadata.type === "new"
      ? "A"
      : file.metadata.type === "deleted"
        ? "D"
        : file.metadata.type.startsWith("rename")
          ? "R"
          : "M";

  const pathLabel = file.previousPath && file.previousPath !== file.path ? `${file.previousPath} -> ${file.path}` : file.path;

  return {
    name: `${prefix} ${pathLabel}`,
    description: `+${file.stats.additions}  -${file.stats.deletions}${file.agent ? "  agent" : ""}`,
    value: file.id,
  };
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

function nextMenuItemIndex(entries: MenuEntry[], currentIndex: number, delta: number) {
  if (entries.length === 0) {
    return 0;
  }

  let candidate = currentIndex;
  for (let remaining = entries.length; remaining > 0; remaining -= 1) {
    candidate = (candidate + delta + entries.length) % entries.length;
    const entry = entries[candidate];
    if (entry?.kind === "item") {
      return candidate;
    }
  }

  return 0;
}

function menuEntryText(entry: Extract<MenuEntry, { kind: "item" }>) {
  const check = entry.checked === undefined ? "    " : entry.checked ? "[x] " : "[ ] ";
  const hint = entry.hint ? ` ${entry.hint}` : "";
  return `${check}${entry.label}${hint}`;
}

function menuWidth(entries: MenuEntry[]) {
  return Math.max(
    18,
    ...entries.map((entry) => (entry.kind === "separator" ? 6 : menuEntryText(entry).length)),
  );
}

function menuBoxHeight(entries: MenuEntry[]) {
  return entries.length + 2;
}

function fileLabel(file: DiffFile | undefined) {
  if (!file) {
    return "No file selected";
  }

  return file.previousPath && file.previousPath !== file.path ? `${file.previousPath} -> ${file.path}` : file.path;
}

function renderMenuLine(
  entry: Extract<MenuEntry, { kind: "item" }>,
  width: number,
  theme: AppTheme,
  selected: boolean,
) {
  const text = entry.checked === undefined ? `  ${entry.label}` : `${entry.checked ? "[x]" : "[ ]"} ${entry.label}`;
  const hint = entry.hint ? entry.hint : "";
  const leftWidth = Math.max(0, width - hint.length - (hint.length > 0 ? 1 : 0));

  return (
    <box style={{ width: "100%", height: 1, flexDirection: "row", justifyContent: "space-between" }}>
      <box style={{ width: leftWidth, height: 1 }}>
        <text fg={theme.text}>{padText(text, leftWidth)}</text>
      </box>
      {hint ? (
        <box style={{ width: hint.length, height: 1 }}>
          <text fg={selected ? theme.text : theme.muted}>{hint}</text>
        </box>
      ) : null}
    </box>
  );
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
  const selectedFileIndex = Math.max(0, filteredFiles.findIndex((file) => file.id === selectedFile?.id));

  const resolvedLayout = layoutMode === "auto" ? (terminal.width >= 150 ? "split" : "stack") : layoutMode;
  const currentHunk = selectedFile?.metadata.hunks[selectedHunkIndex];
  const activeAnnotations = getSelectedAnnotations(selectedFile, currentHunk);
  const availableCenterWidth =
    terminal.width - BODY_PADDING - DIVIDER_WIDTH - (showAgentPanel ? AGENT_WIDTH + AGENT_GAP : 0);
  const maxFilesPaneWidth = Math.max(FILES_MIN_WIDTH, availableCenterWidth - DIFF_MIN_WIDTH);
  const clampedFilesPaneWidth = clamp(filesPaneWidth, FILES_MIN_WIDTH, maxFilesPaneWidth);
  const diffPaneWidth = Math.max(DIFF_MIN_WIDTH, availableCenterWidth - clampedFilesPaneWidth);
  const isResizingFilesPane = resizeDragOriginX !== null && resizeStartWidth !== null;
  const dividerHitLeft = Math.max(
    1,
    1 + clampedFilesPaneWidth - Math.floor((DIVIDER_HIT_WIDTH - DIVIDER_WIDTH) / 2),
  );

  useEffect(() => {
    setFilesPaneWidth((current) => clamp(current, FILES_MIN_WIDTH, maxFilesPaneWidth));
  }, [maxFilesPaneWidth]);

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

  const moveHunk = (delta: number) => {
    if (!selectedFile || selectedFile.metadata.hunks.length === 0) {
      return;
    }

    setSelectedHunkIndex((current) => clamp(current + delta, 0, selectedFile.metadata.hunks.length - 1));
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

    startTransition(() => {
      setSelectedFileId(nextFile.id);
      setSelectedHunkIndex(0);
    });
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

    startTransition(() => {
      setSelectedFileId(nextFile.id);
      setSelectedHunkIndex(0);
    });
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

  const menuSpecs = MENU_ORDER.reduce<{ id: MenuId; left: number; width: number; label: string }[]>((items, id) => {
    const previous = items.at(-1);
    const left = previous ? previous.left + previous.width + 1 : 1;
    items.push({
      id,
      left,
      width: MENU_LABELS[id].length + 2,
      label: MENU_LABELS[id],
    });
    return items;
  }, []);

  const fileOptions = filteredFiles.map(buildFileOption);
  const totalAdditions = bootstrap.changeset.files.reduce((sum, file) => sum + file.stats.additions, 0);
  const totalDeletions = bootstrap.changeset.files.reduce((sum, file) => sum + file.stats.deletions, 0);
  const activeMenuEntries = activeMenuId ? menus[activeMenuId] : [];
  const activeMenuSpec = menuSpecs.find((menu) => menu.id === activeMenuId);
  const activeMenuWidth = menuWidth(activeMenuEntries) + 2;
  const topTitle = `${bootstrap.changeset.title}  +${totalAdditions}  -${totalDeletions}`;
  const helpWidth = Math.min(68, Math.max(44, terminal.width - 8));
  const helpLeft = Math.max(1, Math.floor((terminal.width - helpWidth) / 2));

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
      <box
        style={{
          height: 1,
          backgroundColor: activeTheme.panelAlt,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        {menuSpecs.map((menu) => {
          const active = activeMenuId === menu.id;
          return (
            <box
              key={menu.id}
              style={{
                width: menu.width,
                height: 1,
                backgroundColor: active ? activeTheme.accentMuted : activeTheme.panelAlt,
              }}
              onMouseUp={() => toggleMenu(menu.id)}
              onMouseOver={() => {
                if (activeMenuId) {
                  openMenu(menu.id);
                }
              }}
            >
              <text fg={active ? activeTheme.text : activeTheme.muted}>{` ${menu.label} `}</text>
            </box>
          );
        })}

        <box style={{ flexGrow: 1, height: 1, alignItems: "center", justifyContent: "flex-end" }}>
          <text fg={activeTheme.muted}>{` ${fitText(topTitle, Math.max(0, terminal.width - 41))}`}</text>
        </box>
      </box>

      <box
        style={{
          height: 1,
          backgroundColor: activeTheme.panel,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: 1,
          paddingRight: 1,
        }}
        onMouseUp={() => closeMenu()}
      >
        <text fg={activeTheme.text}>
          {fitText(fileLabel(selectedFile), Math.max(20, terminal.width - 34))}
        </text>
        <text fg={activeTheme.muted}>
          {fitText(
            `${selectedFile ? `hunk ${selectedFile.metadata.hunks.length === 0 ? 0 : selectedHunkIndex + 1}/${selectedFile.metadata.hunks.length}` : "no file"}  ${resolvedLayout}  ${activeTheme.label}`,
            32,
          )}
        </text>
      </box>

      <box
        style={{ flexGrow: 1, flexDirection: "row", gap: 0, padding: 1, position: "relative" }}
        onMouseDrag={updateFilesPaneResize}
        onMouseDragEnd={endFilesPaneResize}
        onMouseUp={(event) => {
          endFilesPaneResize(event);
          closeMenu();
        }}
      >
        <box
          title="Files"
          style={{
            width: clampedFilesPaneWidth,
            border: ["top", "bottom", "left"],
            borderColor: activeTheme.border,
            backgroundColor: activeTheme.panel,
            padding: 1,
            flexDirection: "column",
          }}
        >
          <select
            width="100%"
            height="100%"
            focused={focusArea === "files"}
            options={fileOptions}
            selectedIndex={selectedFileIndex}
            backgroundColor={activeTheme.panel}
            textColor={activeTheme.text}
            focusedBackgroundColor={activeTheme.panelAlt}
            focusedTextColor={activeTheme.text}
            selectedBackgroundColor={activeTheme.accentMuted}
            selectedTextColor={activeTheme.text}
            descriptionColor={activeTheme.muted}
            selectedDescriptionColor={activeTheme.text}
            showScrollIndicator={true}
            showDescription={true}
            wrapSelection={false}
            onChange={(index, option) => {
              const nextId = typeof option?.value === "string" ? option.value : filteredFiles[index]?.id;
              if (!nextId) {
                return;
              }

              startTransition(() => {
                setSelectedFileId(nextId);
                setSelectedHunkIndex(0);
              });
            }}
          />
        </box>

        <box
          style={{
            width: DIVIDER_WIDTH,
            border: ["top", "bottom", "left"],
            borderColor: isResizingFilesPane ? activeTheme.accent : activeTheme.border,
            backgroundColor: isResizingFilesPane ? activeTheme.accentMuted : activeTheme.panel,
          }}
          customBorderChars={{
            topLeft: "┬",
            topRight: "┬",
            bottomLeft: "┴",
            bottomRight: "┴",
            horizontal: "─",
            vertical: "│",
            topT: "┬",
            bottomT: "┴",
            leftT: "├",
            rightT: "┤",
            cross: "┼",
          }}
        />

        <box
          style={{
            position: "absolute",
            top: 1,
            bottom: 1,
            left: dividerHitLeft,
            width: DIVIDER_HIT_WIDTH,
            zIndex: 30,
          }}
          onMouseDown={beginFilesPaneResize}
          onMouseDrag={updateFilesPaneResize}
          onMouseUp={endFilesPaneResize}
          onMouseDragEnd={endFilesPaneResize}
        />

        <box
          title={selectedFile ? selectedFile.path : "Diff"}
          style={{
            width: diffPaneWidth,
            border: ["top", "right", "bottom"],
            borderColor: activeTheme.border,
            backgroundColor: activeTheme.panel,
            padding: 1,
            flexDirection: "column",
          }}
        >
          {selectedFile ? (
            <box style={{ flexGrow: 1, width: "100%" }}>
              <PierreDiffView
                file={selectedFile}
                layout={resolvedLayout}
                theme={activeTheme}
                width={diffPaneWidth}
                selectedHunkIndex={selectedHunkIndex}
              />
            </box>
          ) : (
            <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
              <text fg={activeTheme.muted}>No files match the current filter.</text>
            </box>
          )}
        </box>

        {showAgentPanel ? (
          <box
            title="Agent"
            style={{
              width: AGENT_WIDTH,
              border: true,
              borderColor: activeTheme.border,
              backgroundColor: activeTheme.panel,
              padding: 1,
              marginLeft: AGENT_GAP,
            }}
          >
            <scrollbox width="100%" height="100%" scrollY={true} viewportCulling={true} focused={false}>
              <box style={{ width: "100%", flexDirection: "column", gap: 1, paddingRight: 1 }}>
                {bootstrap.changeset.agentSummary ? (
                  <box
                    title="Changeset"
                    style={{
                      border: true,
                      borderColor: activeTheme.accentMuted,
                      backgroundColor: activeTheme.panelAlt,
                      padding: 1,
                    }}
                  >
                    <text fg={activeTheme.text}>{bootstrap.changeset.agentSummary}</text>
                  </box>
                ) : null}

                {selectedFile?.agent?.summary ? (
                  <box
                    title="File"
                    style={{
                      border: true,
                      borderColor: activeTheme.accentMuted,
                      backgroundColor: activeTheme.panelAlt,
                      padding: 1,
                    }}
                  >
                    <text fg={activeTheme.text}>{selectedFile.agent.summary}</text>
                  </box>
                ) : null}

                {activeAnnotations.length > 0 ? (
                  activeAnnotations.map((annotation, index) => (
                    <box
                      key={`${selectedFile?.id ?? "annotation"}:${index}`}
                      title={`Annotation ${index + 1}`}
                      style={{
                        border: true,
                        borderColor: activeTheme.accentMuted,
                        backgroundColor: activeTheme.panelAlt,
                        padding: 1,
                        flexDirection: "column",
                        gap: 1,
                      }}
                    >
                      <text fg={activeTheme.text}>{annotation.summary}</text>
                      {annotation.rationale ? <text fg={activeTheme.muted}>{annotation.rationale}</text> : null}
                      {annotation.tags && annotation.tags.length > 0 ? (
                        <text fg={activeTheme.badgeNeutral}>tags: {annotation.tags.join(", ")}</text>
                      ) : null}
                      {annotation.confidence ? (
                        <text fg={activeTheme.badgeNeutral}>confidence: {annotation.confidence}</text>
                      ) : null}
                    </box>
                  ))
                ) : (
                  <box
                    title="Selection"
                    style={{
                      border: true,
                      borderColor: activeTheme.accentMuted,
                      backgroundColor: activeTheme.panelAlt,
                      padding: 1,
                    }}
                  >
                    <text fg={activeTheme.muted}>
                      {selectedFile?.agent
                        ? "No annotation is attached to the current hunk."
                        : "No agent metadata is attached to the current file."}
                    </text>
                  </box>
                )}

                {bootstrap.changeset.summary ? (
                  <box
                    title="Patch"
                    style={{
                      border: true,
                      borderColor: activeTheme.accentMuted,
                      backgroundColor: activeTheme.panelAlt,
                      padding: 1,
                    }}
                  >
                    <text fg={activeTheme.muted}>{bootstrap.changeset.summary}</text>
                  </box>
                ) : null}
              </box>
            </scrollbox>
          </box>
        ) : null}
      </box>

      <box
        style={{
          height: 1,
          backgroundColor: activeTheme.panelAlt,
          paddingLeft: 1,
          paddingRight: 1,
          alignItems: "center",
          flexDirection: "row",
        }}
        onMouseUp={() => closeMenu()}
      >
        {focusArea === "filter" ? (
          <>
            <text fg={activeTheme.badgeNeutral}>filter:</text>
            <box style={{ width: 1, height: 1 }}>
              <text fg={activeTheme.muted}> </text>
            </box>
            <input
              width={Math.max(12, terminal.width - 11)}
              value={filter}
              placeholder="type to filter files"
              focused={true}
              onInput={setFilter}
              onSubmit={() => setFocusArea("files")}
            />
          </>
        ) : (
          <text fg={activeTheme.muted}>
            {fitText(
              `F10 menu  drag divider resize  / filter  [ ] hunks  j k files  1 2 0 layout  t theme  a agent  q quit${filter ? `  filter=${filter}` : ""}`,
              terminal.width - 2,
            )}
          </text>
        )}
      </box>

      {activeMenuId && activeMenuSpec ? (
        <box
          style={{
            position: "absolute",
            top: 1,
            left: activeMenuSpec.left,
            width: activeMenuWidth,
            height: menuBoxHeight(activeMenuEntries),
            zIndex: 40,
            border: true,
            borderColor: activeTheme.border,
            backgroundColor: activeTheme.panel,
            flexDirection: "column",
          }}
        >
          {activeMenuEntries.map((entry, index) =>
            entry.kind === "separator" ? (
              <box key={`${activeMenuId}:separator:${index}`} style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
                <text fg={activeTheme.border}>{padText("-".repeat(activeMenuWidth - 4), activeMenuWidth - 2)}</text>
              </box>
            ) : (
              <box
                key={`${activeMenuId}:${entry.label}`}
                style={{
                  height: 1,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexDirection: "row",
                  backgroundColor: activeMenuItemIndex === index ? activeTheme.accentMuted : activeTheme.panel,
                }}
                onMouseOver={() => setActiveMenuItemIndex(index)}
                onMouseUp={() => {
                  entry.action();
                  closeMenu();
                }}
              >
                {renderMenuLine(entry, activeMenuWidth - 2, activeTheme, activeMenuItemIndex === index)}
              </box>
            ),
          )}
        </box>
      ) : null}

      {showHelp ? (
        <box
          style={{
            position: "absolute",
            top: 3,
            left: helpLeft,
            width: helpWidth,
            height: 9,
            zIndex: 60,
            border: true,
            borderColor: activeTheme.accent,
            backgroundColor: activeTheme.panel,
            padding: 1,
            flexDirection: "column",
            gap: 1,
          }}
          onMouseUp={() => setShowHelp(false)}
        >
          <text fg={activeTheme.text}>Keyboard</text>
          <text fg={activeTheme.muted}>F10 menus  arrows navigate menus  Enter select  Esc close menu</text>
          <text fg={activeTheme.muted}>1 split  2 stack  0 auto  t cycle theme  a toggle agent rail</text>
          <text fg={activeTheme.muted}>[ previous hunk  ] next hunk  j next file  k previous file</text>
          <text fg={activeTheme.muted}>drag the Files/Diff divider with the mouse to resize the columns</text>
          <text fg={activeTheme.muted}>/ focus filter  Tab swap files/filter  q quit</text>
          <text fg={activeTheme.badgeNeutral}>click anywhere on this panel to close</text>
        </box>
      ) : null}
    </box>
  );
}

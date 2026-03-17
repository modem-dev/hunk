import type { KeyEvent, SelectOption, TabSelectOption, TabSelectRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { Hunk } from "@pierre/diffs";
import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import type { AppBootstrap, DiffFile, LayoutMode } from "../core/types";
import { PierreDiffView } from "./PierreDiffView";
import { resolveTheme, THEMES } from "./themes";

type FocusArea = "files" | "filter" | "layout" | "theme";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function overlap(rangeA: [number, number], rangeB: [number, number]) {
  return rangeA[0] <= rangeB[1] && rangeB[0] <= rangeA[1];
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

  const pathLabel = file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ${file.path}` : file.path;

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

function getHunkSummary(hunk: Hunk | undefined) {
  if (!hunk) {
    return "No hunks";
  }

  const parts = [`-${hunk.deletionStart},${hunk.deletionLines}`, `+${hunk.additionStart},${hunk.additionLines}`];
  return hunk.hunkContext ? `${parts.join("  ")}  ${hunk.hunkContext}` : parts.join("  ");
}

function cycleFocus(current: FocusArea): FocusArea {
  switch (current) {
    case "files":
      return "filter";
    case "filter":
      return "layout";
    case "layout":
      return "theme";
    case "theme":
      return "files";
  }
}

export function App({ bootstrap }: { bootstrap: AppBootstrap }) {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const layoutTabsRef = useRef<TabSelectRenderable>(null);
  const themeTabsRef = useRef<TabSelectRenderable>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(bootstrap.initialMode);
  const [themeId, setThemeId] = useState(() => resolveTheme(bootstrap.initialTheme, renderer.themeMode).id);
  const [showAgentPanel, setShowAgentPanel] = useState(
    () => Boolean(bootstrap.changeset.agentSummary) || bootstrap.changeset.files.some((file) => file.agent),
  );
  const [focusArea, setFocusArea] = useState<FocusArea>("files");
  const [filter, setFilter] = useState("");
  const [selectedFileId, setSelectedFileId] = useState(bootstrap.changeset.files[0]?.id ?? "");
  const [selectedHunkIndex, setSelectedHunkIndex] = useState(0);
  const deferredFilter = useDeferredValue(filter);

  const activeTheme = resolveTheme(themeId, renderer.themeMode);
  const layoutOptions: TabSelectOption[] = [
    { name: "Auto", description: "Responsive" },
    { name: "Split", description: "2 column" },
    { name: "Stack", description: "1 column" },
  ];
  const themeOptions: TabSelectOption[] = THEMES.map((theme) => ({
    name: theme.label,
    description: theme.id,
  }));

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
  const selectedFileIndex = Math.max(
    0,
    filteredFiles.findIndex((file) => file.id === selectedFile?.id),
  );

  const resolvedLayout =
    layoutMode === "auto" ? (terminal.width >= 150 ? "split" : "stack") : layoutMode;
  const currentHunk = selectedFile?.metadata.hunks[selectedHunkIndex];
  const activeAnnotations = getSelectedAnnotations(selectedFile, currentHunk);

  useEffect(() => {
    const themeIndex = THEMES.findIndex((theme) => theme.id === activeTheme.id);
    if (themeIndex >= 0) {
      themeTabsRef.current?.setSelectedIndex(themeIndex);
    }
  }, [activeTheme.id]);

  useEffect(() => {
    const layoutIndex = layoutMode === "auto" ? 0 : layoutMode === "split" ? 1 : 2;
    layoutTabsRef.current?.setSelectedIndex(layoutIndex);
  }, [layoutMode]);

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

  useKeyboard((key: KeyEvent) => {
    if (key.name === "q" || key.name === "escape") {
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
      setFocusArea((current) => cycleFocus(current));
      return;
    }

    if (key.name === "/") {
      setFocusArea("filter");
      return;
    }

    if (key.name === "1") {
      setLayoutMode("split");
      return;
    }

    if (key.name === "2") {
      setLayoutMode("stack");
      return;
    }

    if (key.name === "0") {
      setLayoutMode("auto");
      return;
    }

    if (key.name === "t") {
      const currentIndex = THEMES.findIndex((theme) => theme.id === activeTheme.id);
      const nextIndex = (currentIndex + 1) % THEMES.length;
      setThemeId(THEMES[nextIndex]!.id);
      return;
    }

    if (key.name === "a") {
      setShowAgentPanel((current) => !current);
      return;
    }

    if (key.name === "[") {
      moveHunk(-1);
      return;
    }

    if (key.name === "]") {
      moveHunk(1);
      return;
    }
  });

  const fileOptions = filteredFiles.map(buildFileOption);
  const totalAdditions = bootstrap.changeset.files.reduce((sum, file) => sum + file.stats.additions, 0);
  const totalDeletions = bootstrap.changeset.files.reduce((sum, file) => sum + file.stats.deletions, 0);
  const diffPaneWidth = Math.max(48, terminal.width - 44 - (showAgentPanel ? 40 : 0));

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        padding: 1,
        gap: 1,
        backgroundColor: activeTheme.background,
      }}
    >
      <box
        style={{
          border: true,
          borderColor: activeTheme.border,
          backgroundColor: activeTheme.panel,
          padding: 1,
          flexDirection: "column",
          gap: 1,
        }}
      >
        <box style={{ justifyContent: "space-between", alignItems: "center" }}>
          <box style={{ flexDirection: "column" }}>
            <text fg={activeTheme.text}>{bootstrap.changeset.title}</text>
            <text fg={activeTheme.muted}>{bootstrap.changeset.sourceLabel}</text>
          </box>
          <box style={{ flexDirection: "column", alignItems: "flex-end" }}>
            <text fg={activeTheme.badgeAdded}>+{totalAdditions}</text>
            <text fg={activeTheme.badgeRemoved}>-{totalDeletions}</text>
          </box>
        </box>

        <box style={{ gap: 1, alignItems: "center" }}>
          <text fg={activeTheme.muted}>layout</text>
          <tab-select
            ref={layoutTabsRef}
            width={42}
            height={3}
            options={layoutOptions}
            showDescription={false}
            tabWidth={12}
            focused={focusArea === "layout"}
            backgroundColor={activeTheme.panelAlt}
            textColor={activeTheme.muted}
            selectedBackgroundColor={activeTheme.accentMuted}
            selectedTextColor={activeTheme.text}
            focusedBackgroundColor={activeTheme.panelAlt}
            focusedTextColor={activeTheme.text}
            selectedDescriptionColor={activeTheme.text}
            onChange={(index) => {
              setLayoutMode(index === 0 ? "auto" : index === 1 ? "split" : "stack");
            }}
          />

          <text fg={activeTheme.muted}>theme</text>
          <tab-select
            ref={themeTabsRef}
            width={56}
            height={3}
            options={themeOptions}
            showDescription={false}
            tabWidth={13}
            focused={focusArea === "theme"}
            backgroundColor={activeTheme.panelAlt}
            textColor={activeTheme.muted}
            selectedBackgroundColor={activeTheme.accentMuted}
            selectedTextColor={activeTheme.text}
            focusedBackgroundColor={activeTheme.panelAlt}
            focusedTextColor={activeTheme.text}
            selectedDescriptionColor={activeTheme.text}
            onChange={(index) => {
              const nextTheme = THEMES[index];
              if (nextTheme) {
                setThemeId(nextTheme.id);
              }
            }}
          />
        </box>

        <text fg={activeTheme.muted}>
          `q` quit  `tab` cycle focus  `/` filter  `[` `]` hunks  `a` agent rail  `{resolvedLayout}` at {terminal.width} cols
        </text>
      </box>

      <box style={{ flexGrow: 1, flexDirection: "row", gap: 1 }}>
        <box
          title="Files"
          style={{
            width: 34,
            border: true,
            borderColor: activeTheme.border,
            backgroundColor: activeTheme.panel,
            padding: 1,
            flexDirection: "column",
            gap: 1,
          }}
        >
          <box
            title="Filter"
            style={{
              border: true,
              borderColor: focusArea === "filter" ? activeTheme.accent : activeTheme.accentMuted,
              backgroundColor: activeTheme.panelAlt,
              height: 3,
            }}
          >
            <input
              value={filter}
              placeholder="type to filter files"
              focused={focusArea === "filter"}
              onInput={setFilter}
              onSubmit={() => setFocusArea("files")}
            />
          </box>

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
          title={selectedFile ? selectedFile.path : "Diff"}
          style={{
            flexGrow: 1,
            border: true,
            borderColor: activeTheme.border,
            backgroundColor: activeTheme.panel,
            padding: 1,
            flexDirection: "column",
            gap: 1,
          }}
        >
          {selectedFile ? (
            <>
              <box style={{ justifyContent: "space-between", alignItems: "center" }}>
                <box style={{ flexDirection: "column" }}>
                  <text fg={activeTheme.text}>
                    {selectedFile.previousPath && selectedFile.previousPath !== selectedFile.path
                      ? `${selectedFile.previousPath} → ${selectedFile.path}`
                      : selectedFile.path}
                  </text>
                  <text fg={activeTheme.muted}>
                    {selectedFile.metadata.type}  +{selectedFile.stats.additions}  -{selectedFile.stats.deletions}
                  </text>
                </box>
                <box style={{ flexDirection: "column", alignItems: "flex-end" }}>
                  <text fg={activeTheme.badgeNeutral}>
                    hunk {selectedFile.metadata.hunks.length === 0 ? 0 : selectedHunkIndex + 1}/{selectedFile.metadata.hunks.length}
                  </text>
                  <text fg={activeTheme.muted}>{getHunkSummary(currentHunk)}</text>
                </box>
              </box>

              <box style={{ flexGrow: 1, width: "100%" }}>
                <PierreDiffView
                  file={selectedFile}
                  layout={resolvedLayout}
                  theme={activeTheme}
                  width={diffPaneWidth}
                  selectedHunkIndex={selectedHunkIndex}
                />
              </box>
            </>
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
              width: 38,
              border: true,
              borderColor: activeTheme.border,
              backgroundColor: activeTheme.panel,
              padding: 1,
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
    </box>
  );
}

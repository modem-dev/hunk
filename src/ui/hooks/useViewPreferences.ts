import type { ThemeMode } from "@opentui/core";
import { useCallback, useMemo, useRef, useState } from "react";
import type { AppBootstrap, CliInput, LayoutMode } from "../../core/types";
import { resolveTheme, THEMES } from "../themes";

interface CurrentViewOptions {
  layoutMode: LayoutMode;
  themeId: string;
  showAgentNotes: boolean;
  showHunkHeaders: boolean;
  showLineNumbers: boolean;
  wrapLines: boolean;
}

/** Preserve the active shell view settings when rebuilding the current input. */
export function withCurrentViewOptions(input: CliInput, view: CurrentViewOptions): CliInput {
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

/** Own the shell's persistent view preferences and the actions that mutate them. */
export function useViewPreferences(bootstrap: AppBootstrap, themeMode: ThemeMode | null) {
  const wrapToggleScrollTopRef = useRef<number | null>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(bootstrap.initialMode);
  const [themeId, setThemeId] = useState(() => resolveTheme(bootstrap.initialTheme, themeMode).id);
  const [showAgentNotes, setShowAgentNotes] = useState(bootstrap.initialShowAgentNotes ?? false);
  const [showLineNumbers, setShowLineNumbers] = useState(bootstrap.initialShowLineNumbers ?? true);
  const [wrapLines, setWrapLines] = useState(bootstrap.initialWrapLines ?? false);
  const [showHunkHeaders, setShowHunkHeaders] = useState(bootstrap.initialShowHunkHeaders ?? true);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [forceSidebarOpen, setForceSidebarOpen] = useState(false);

  const activeTheme = useMemo(() => resolveTheme(themeId, themeMode), [themeId, themeMode]);

  const toggleAgentNotes = useCallback(() => {
    setShowAgentNotes((current) => !current);
  }, []);

  const toggleLineNumbers = useCallback(() => {
    setShowLineNumbers((current) => !current);
  }, []);

  const toggleLineWrap = useCallback((scrollTop: number) => {
    wrapToggleScrollTopRef.current = scrollTop;
    setWrapLines((current) => !current);
  }, []);

  const toggleHunkHeaders = useCallback(() => {
    setShowHunkHeaders((current) => !current);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeId((currentThemeId) => {
      const resolvedThemeId = resolveTheme(currentThemeId, themeMode).id;
      const currentIndex = THEMES.findIndex((theme) => theme.id === resolvedThemeId);
      return THEMES[(currentIndex + 1) % THEMES.length]!.id;
    });
  }, [themeMode]);

  return {
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
    toggleLineWrap,
    toggleTheme,
    wrapLines,
    wrapToggleScrollTopRef,
  };
}

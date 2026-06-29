import {
  MouseButton,
  type MouseEvent as TuiMouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, useRef } from "react";
import type { AppBootstrap, CliInput, LayoutMode, UserNoteLineTarget } from "../core/types";
import { canReloadInput, computeConfigSignature, computeWatchSignature } from "../core/watch";
import type { HunkSessionBrokerClient, ReloadedSessionResult } from "../hunk-session/types";
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
import type { ActiveAddNoteAffordance } from "./diff/PierreDiffView";
import { useAppKeyboardShortcuts } from "./hooks/useAppKeyboardShortcuts";
import { useHunkSessionBridge } from "./hooks/useHunkSessionBridge";
import { useMenuController } from "./hooks/useMenuController";
import { useReviewController } from "./hooks/useReviewController";
import { buildAppMenus } from "./lib/appMenus";
import { fileRowId } from "./lib/ids";
import { openSelectedFileInEditor } from "./lib/openInEditor";
import { resolveResponsiveLayout } from "./lib/responsive";
import { resizeSidebarWidth } from "./lib/sidebar";
import { availableThemes, resolveTheme, withTransparentBackground } from "./themes";

type FocusArea = "files" | "filter" | "note";
type ActiveAddNoteTarget = ActiveAddNoteAffordance & { fileId: string };
type ThemeSelectorState = {
  open: boolean;
  selectedIndex: number;
  previewThemeId: string | null;
};

const FAST_CODE_HORIZONTAL_SCROLL_COLUMNS = 8;

const LazyAgentSkillDialog = lazy(async () => ({
  default: (await import("./components/chrome/AgentSkillDialog")).AgentSkillDialog,
}));
const LazyHelpDialog = lazy(async () => ({
  default: (await import("./components/chrome/HelpDialog")).HelpDialog,
}));
const LazyMenuDropdown = lazy(async () => ({
  default: (await import("./components/chrome/MenuDropdown")).MenuDropdown,
}));
const LazyThemeSelectorDialog = lazy(async () => ({
  default: (await import("./components/chrome/ThemeSelectorDialog")).ThemeSelectorDialog,
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
    showMenuBar: boolean;
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
      menuBar: view.showMenuBar,
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
  hostClient?: HunkSessionBrokerClient;
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

  const pagerMode = Boolean(bootstrap.input.options.pager);
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const sidebarScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const wrapToggleScrollTopRef = useRef<number | null>(null);
  const layoutToggleScrollTopRef = useRef<number | null>(null);
  const cancelCopySelectionRef = useRef<(() => void) | null>(null);
  const [layoutToggleRequestId, setLayoutToggleRequestId] = useState(0);
  const [transientNoticeText, setTransientNoticeText] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(bootstrap.initialMode);
  const [themeId, setThemeId] = useState(
    () =>
      resolveTheme(
        bootstrap.initialTheme,
        bootstrap.initialThemeMode ?? renderer.themeMode,
        bootstrap.customTheme,
      ).id,
  );
  // Soft reloads replace bootstrap without re-running startup terminal theme detection.
  const [detectedThemeMode] = useState(() => bootstrap.initialThemeMode);
  const [showAgentNotes, setShowAgentNotes] = useState(bootstrap.initialShowAgentNotes ?? false);
  const [showLineNumbers, setShowLineNumbers] = useState(bootstrap.initialShowLineNumbers ?? true);
  const [wrapLines, setWrapLines] = useState(bootstrap.initialWrapLines ?? false);
  const [copyDecorations, setCopyDecorations] = useState(bootstrap.initialCopyDecorations ?? false);
  const [codeHorizontalOffset, setCodeHorizontalOffset] = useState(0);
  const [showHunkHeaders, setShowHunkHeaders] = useState(bootstrap.initialShowHunkHeaders ?? true);
  const [showMenuBar, setShowMenuBar] = useState(bootstrap.initialShowMenuBar ?? true);
  const [themeSelectorState, setThemeSelectorState] = useState<ThemeSelectorState>({
    open: false,
    selectedIndex: 0,
    previewThemeId: null,
  });
  const [sidebarVisible, setSidebarVisible] = useState(() => !pagerMode);
  const [forceSidebarOpen, setForceSidebarOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAgentSkill, setShowAgentSkill] = useState(false);
  const [focusArea, setFocusArea] = useState<FocusArea>("files");
  const [activeAddNoteTarget, setActiveAddNoteTarget] = useState<ActiveAddNoteTarget | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(34);
  const [resizeDragOriginX, setResizeDragOriginX] = useState<number | null>(null);
  const [resizeStartWidth, setResizeStartWidth] = useState<number | null>(null);
  const [sessionNoticeText, setSessionNoticeText] = useState<string | null>(null);
  const sessionNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const themeOptions = useMemo(
    () => availableThemes(bootstrap.customTheme),
    [bootstrap.customTheme],
  );
  const effectiveThemeId = themeSelectorState.previewThemeId ?? themeId;
  const baseTheme = useMemo(
    () => resolveTheme(effectiveThemeId, detectedThemeMode ?? null, bootstrap.customTheme),
    [effectiveThemeId, detectedThemeMode, bootstrap.customTheme],
  );
  const activeTheme = useMemo(
    () =>
      bootstrap.input.options.transparentBackground
        ? withTransparentBackground(baseTheme)
        : baseTheme,
    [baseTheme, bootstrap.input.options.transparentBackground],
  );

  const themeSelectorItems = useMemo(
    () =>
      themeOptions.map((theme) => ({
        id: theme.id,
        label: theme.label,
        description: theme.id === activeTheme.id ? "active" : "",
        active: theme.id === activeTheme.id,
      })),
    [activeTheme.id, themeOptions],
  );
  const review = useReviewController({ files: bootstrap.changeset.files });
  const filteredFiles = review.visibleFiles;
  const selectedFile = review.selectedFile;
  const selectedHunkIndex = review.selectedHunkIndex;
  const moveToAnnotatedFile = review.moveToAnnotatedFile;
  const moveToAnnotatedHunk = review.moveToAnnotatedHunk;
  const moveToFile = review.moveToFile;

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

  const showSessionNotice = useCallback((message: string) => {
    setSessionNoticeText(message);
    if (sessionNoticeTimeoutRef.current) {
      clearTimeout(sessionNoticeTimeoutRef.current);
    }

    sessionNoticeTimeoutRef.current = setTimeout(() => {
      setSessionNoticeText((current) => (current === message ? null : current));
      sessionNoticeTimeoutRef.current = null;
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (sessionNoticeTimeoutRef.current) {
        clearTimeout(sessionNoticeTimeoutRef.current);
      }
    };
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
    reviewNoteCount: review.reviewNoteCount,
    reviewNoteSummaries: review.reviewNoteSummaries,
    selectedFile,
    selectedHunk: review.selectedHunk,
    selectedHunkIndex,
    showAgentNotes,
  });

  const bodyPadding = pagerMode ? 0 : BODY_PADDING;
  const bodyWidth = Math.max(0, terminal.width - bodyPadding);
  const responsiveLayout = resolveResponsiveLayout(layoutMode, terminal.width);
  const canForceShowSidebar = bodyWidth >= SIDEBAR_MIN_WIDTH + DIVIDER_WIDTH + DIFF_MIN_WIDTH;
  const renderSidebar =
    sidebarVisible && (responsiveLayout.showSidebar || (forceSidebarOpen && canForceShowSidebar));
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

  /** Toggle whether mouse selection copies review decorations or only file content. */
  const toggleCopyDecorations = () => {
    setCopyDecorations((current) => !current);
  };

  // Show a short-lived status-bar message. Used to surface clipboard-copy outcomes that would
  // otherwise be invisible to the user (OSC52 unsupported, etc.).
  // Track the timer so we can clear it on unmount and avoid React state updates after unmount.
  const transientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTransientNotice = useCallback((text: string, durationMs = 3000) => {
    if (transientTimerRef.current !== null) {
      clearTimeout(transientTimerRef.current);
    }
    setTransientNoticeText(text);
    transientTimerRef.current = setTimeout(() => {
      transientTimerRef.current = null;
      setTransientNoticeText((current) => (current === text ? null : current));
    }, durationMs);
  }, []);

  // Clear any pending transient-notice timer on unmount to avoid state updates after unmount.
  useEffect(() => {
    return () => {
      if (transientTimerRef.current !== null) {
        clearTimeout(transientTimerRef.current);
      }
    };
  }, []);

  /** Toggle whether diff code rows wrap instead of truncating to one terminal row. */
  const toggleLineWrap = () => {
    // Capture the pre-toggle viewport position synchronously so DiffPane can restore the same
    // top-most source row after wrapped row heights change.
    wrapToggleScrollTopRef.current = diffScrollRef.current?.scrollTop ?? 0;
    setCodeHorizontalOffset(0);
    setWrapLines((current) => !current);
  };

  /** Switch the active theme. */
  const selectTheme = useCallback(
    (nextThemeId: string) => {
      const nextTheme = themeOptions.find((theme) => theme.id === nextThemeId);
      setThemeId(nextThemeId);
      showTransientNotice(`Theme: ${nextTheme?.label ?? nextThemeId}`);
    },
    [showTransientNotice, themeOptions],
  );

  /** Open the keyboard-driven theme selector with the current theme highlighted. */
  const openThemeSelector = useCallback(() => {
    const currentIndex = themeSelectorItems.findIndex((item) => item.id === activeTheme.id);
    setThemeSelectorState({
      open: true,
      selectedIndex: Math.max(0, currentIndex),
      previewThemeId: null,
    });
  }, [activeTheme.id, themeSelectorItems]);

  const closeThemeSelector = useCallback(() => {
    // Dropping the preview id reverts all previewed colors in the same state transition.
    setThemeSelectorState((current) => ({ ...current, open: false, previewThemeId: null }));
  }, []);

  const moveThemeSelector = useCallback(
    (delta: number) => {
      setThemeSelectorState((current) => {
        if (themeSelectorItems.length === 0) {
          return { ...current, selectedIndex: 0, previewThemeId: null };
        }

        const nextIndex =
          (current.selectedIndex + delta + themeSelectorItems.length) % themeSelectorItems.length;
        const item = themeSelectorItems[nextIndex]!;
        return { ...current, selectedIndex: nextIndex, previewThemeId: item.id };
      });
    },
    [themeSelectorItems],
  );

  const pickThemeSelectorItem = useCallback(
    (index: number) => {
      const item = themeSelectorItems[index];
      if (!item) {
        return;
      }

      setThemeSelectorState((current) => ({
        ...current,
        selectedIndex: index,
        previewThemeId: item.id,
      }));
    },
    [themeSelectorItems],
  );

  const acceptThemeSelector = useCallback(() => {
    const item = themeSelectorItems[themeSelectorState.selectedIndex];
    if (!item) {
      return;
    }

    selectTheme(item.id);
    // Close without a preview id; the committed theme id now supplies the same effective theme.
    setThemeSelectorState((current) => ({ ...current, open: false, previewThemeId: null }));
  }, [selectTheme, themeSelectorState.selectedIndex, themeSelectorItems]);

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

  /** Toggle the top menu bar while keeping F10 menu navigation available. */
  const toggleMenuBar = () => {
    setShowMenuBar((current) => !current);
  };

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
      showMenuBar,
      wrapLines,
    });

    await onReloadSession(nextInput, {
      resetApp: false,
      sourcePath:
        bootstrap.input.kind === "vcs" ||
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
    showMenuBar,
    themeId,
    wrapLines,
  ]);

  const triggerRefreshCurrentInput = useCallback(() => {
    void refreshCurrentInput().catch((error) => {
      console.error("Failed to reload the current diff.", error);
    });
  }, [refreshCurrentInput]);

  const triggerEditSelectedFile = useCallback(() => {
    const basePath =
      bootstrap.input.kind === "vcs" ||
      bootstrap.input.kind === "show" ||
      bootstrap.input.kind === "stash-show"
        ? bootstrap.changeset.sourceLabel
        : undefined;
    const message = openSelectedFileInEditor({
      basePath,
      file: selectedFile,
      renderer,
      selectedHunk: review.selectedHunk,
    });

    if (message) {
      showSessionNotice(message);
      return;
    }

    if (canRefreshCurrentInput) {
      triggerRefreshCurrentInput();
    }
  }, [
    bootstrap.changeset.sourceLabel,
    bootstrap.input.kind,
    canRefreshCurrentInput,
    renderer,
    review.selectedHunk,
    selectedFile,
    showSessionNotice,
    triggerRefreshCurrentInput,
  ]);

  // Always live-reload when Hunk's config files (~/.config/hunk/config.toml,
  // repo-local .hunk/config.toml) change — theme/chrome edits repaint immediately,
  // the way VS Code / Cursor apply settings on save, no --watch required. In
  // --watch mode this same loop ALSO tracks the diff input. Folding both into one
  // poll keeps a single in-flight guard, so a config reload can never race a diff
  // reload. Reusing refreshCurrentInput re-reads config — so palette edits repaint
  // live — while preserving the active view options (and any CLI overrides).
  useEffect(() => {
    if (!canRefreshCurrentInput) {
      return;
    }

    let cancelled = false;
    let polling = false;
    let refreshing = false;
    let lastInputSignature: string;
    let lastConfigSignature: string;

    try {
      lastInputSignature = watchEnabled ? computeWatchSignature(bootstrap.input) : "";
      lastConfigSignature = computeConfigSignature();
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
        const nextInputSignature = watchEnabled ? computeWatchSignature(bootstrap.input) : "";
        const nextConfigSignature = computeConfigSignature();
        if (
          nextInputSignature !== lastInputSignature ||
          nextConfigSignature !== lastConfigSignature
        ) {
          lastInputSignature = nextInputSignature;
          lastConfigSignature = nextConfigSignature;
          refreshing = true;
          void refreshCurrentInput()
            .catch((error) => {
              console.error("Failed to auto-reload after a watched change.", error);
            })
            .finally(() => {
              refreshing = false;
            });
        }
      } catch (error) {
        console.error("Failed to poll watch mode.", error);
      } finally {
        polling = false;
      }
    };

    const interval = setInterval(pollForChanges, 250);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [bootstrap.input, canRefreshCurrentInput, refreshCurrentInput, watchEnabled]);

  /** Leave the app through the shared shutdown path. */
  const requestQuit = useCallback(() => {
    onQuit();
  }, [onQuit]);

  /** Close the modal keyboard help overlay. */
  const closeHelp = useCallback(() => {
    setShowHelp(false);
  }, []);

  /** Close the agent skill setup overlay. */
  const closeAgentSkill = useCallback(() => {
    setShowAgentSkill(false);
  }, []);

  /** Open the agent skill setup overlay. */
  const openAgentSkill = useCallback(() => {
    setShowAgentSkill(true);
  }, []);

  /** Copy the agent skill prompt through the terminal clipboard integration. */
  const copyAgentSkillPrompt = useCallback(async () => {
    const { AGENT_SKILL_PROMPT } = await import("./components/chrome/AgentSkillDialog");
    if (renderer.isOsc52Supported?.() && typeof renderer.copyToClipboardOSC52 === "function") {
      renderer.copyToClipboardOSC52(AGENT_SKILL_PROMPT);
      showTransientNotice("Copied agent skill prompt to clipboard");
      return;
    }

    showTransientNotice("Clipboard copy unsupported in this terminal (enable OSC 52)");
  }, [renderer, showTransientNotice]);

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

  /** Start a user-authored inline note and move keyboard focus into it. */
  const startUserNote = useCallback(
    (fileId?: string, hunkIndex?: number, target?: UserNoteLineTarget) => {
      const hoverTarget = fileId === undefined ? activeAddNoteTarget : null;
      const draft = review.startUserNote(
        fileId ?? hoverTarget?.fileId,
        hunkIndex ?? hoverTarget?.hunkIndex,
        target ?? hoverTarget?.target,
      );
      if (draft) {
        setActiveAddNoteTarget(null);
        setFocusArea("note");
      }
    },
    [activeAddNoteTarget, review.startUserNote],
  );

  /** Mark the inline draft note textarea as the active keyboard input. */
  const focusDraftNote = useCallback(() => {
    setFocusArea("note");
  }, []);

  /** Return keyboard focus to review navigation when the draft textarea loses focus. */
  const blurDraftNote = useCallback(() => {
    setFocusArea((current) => (current === "note" ? "files" : current));
  }, []);

  /** Save the active draft note and return focus to review navigation. */
  const saveDraftNote = useCallback(() => {
    review.saveDraftNote();
    setFocusArea("files");
  }, [review.saveDraftNote]);

  /** Cancel the active draft note and return focus to review navigation. */
  const cancelDraftNote = useCallback(() => {
    review.cancelDraftNote();
    setFocusArea("files");
  }, [review.cancelDraftNote]);

  const menus = useMemo(
    () =>
      buildAppMenus({
        canRefreshCurrentInput,
        focusFilter,
        layoutMode,
        moveToAnnotatedFile,
        moveToAnnotatedHunk,
        moveToHunk: review.moveToHunk,
        refreshCurrentInput: triggerRefreshCurrentInput,
        requestQuit,
        selectLayoutMode,
        openThemeSelector,
        copyDecorations,
        showAgentNotes,
        showHelp,
        showHunkHeaders,
        showLineNumbers,
        showMenuBar,
        renderSidebar,
        toggleCopyDecorations,
        toggleAgentNotes,
        toggleFocusArea,
        openAgentSkill,
        toggleHelp,
        toggleHunkHeaders,
        toggleLineNumbers,
        toggleMenuBar,
        toggleLineWrap,
        toggleSidebar,
        triggerEditSelectedFile,
        wrapLines,
      }),
    [
      canRefreshCurrentInput,
      copyDecorations,
      focusFilter,
      layoutMode,
      moveToAnnotatedFile,
      moveToAnnotatedHunk,
      requestQuit,
      review.moveToHunk,
      openAgentSkill,
      selectLayoutMode,
      openThemeSelector,
      triggerRefreshCurrentInput,
      toggleCopyDecorations,
      showAgentNotes,
      showHelp,
      showHunkHeaders,
      showLineNumbers,
      showMenuBar,
      renderSidebar,
      toggleAgentNotes,
      toggleFocusArea,
      toggleHelp,
      toggleHunkHeaders,
      toggleLineNumbers,
      toggleMenuBar,
      toggleLineWrap,
      toggleSidebar,
      triggerEditSelectedFile,
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
    closeAgentSkill,
    closeHelp,
    closeMenu,
    acceptThemeSelector,
    cancelDraftNote,
    closeThemeSelector,
    focusArea,
    focusFilter,
    moveToAnnotatedHunk,
    moveToFile,
    moveToHunk: review.moveToHunk,
    moveMenuItem,
    moveThemeSelector,
    openMenu,
    openThemeSelector,
    pagerMode,
    requestQuit,
    scrollCodeHorizontally,
    saveDraftNote,
    scrollDiff,
    selectLayoutMode,
    showAgentSkill,
    showHelp,
    startUserNote: () => startUserNote(),
    switchMenu,
    themeSelectorOpen: themeSelectorState.open,
    toggleAgentNotes,
    toggleFocusArea,
    toggleGapForSelectedHunk: review.toggleSelectedHunkGap,
    toggleHelp,
    toggleHunkHeaders,
    toggleLineNumbers,
    toggleMenuBar,
    toggleLineWrap,
    toggleSidebar,
    triggerEditSelectedFile,
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
  // Mirror the App layout: bodyPadding/2 left-padding, then sidebar + divider when visible. Keep
  // this in lockstep with the body container's paddingLeft and the sidebar render branch below.
  const diffPaneScreenLeft =
    bodyPadding / 2 + (renderSidebar ? clampedSidebarWidth + DIVIDER_WIDTH : 0);
  const diffPaneScreenTop = pagerMode || !showMenuBar ? 0 : 1;

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: activeTheme.background,
      }}
    >
      {!pagerMode && showMenuBar ? (
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
        onMouseDragEnd={(event) => {
          endSidebarResize(event);
          cancelCopySelectionRef.current?.();
        }}
        onMouseUp={(event) => {
          endSidebarResize(event);
          closeMenu();
          cancelCopySelectionRef.current?.();
        }}
      >
        {renderSidebar ? (
          <>
            <SidebarPane
              entries={review.sidebarEntries}
              scrollRef={sidebarScrollRef}
              selectedFileId={selectedFile?.id}
              showTopChrome={showMenuBar}
              textWidth={sidebarTextWidth}
              theme={activeTheme}
              width={clampedSidebarWidth}
              estimatedViewportRows={terminal.height}
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
          cancelCopySelectionRef={cancelCopySelectionRef}
          codeHorizontalOffset={codeHorizontalOffset}
          copyDecorations={copyDecorations}
          diffContentWidth={diffContentWidth}
          expandedGapsByFileId={review.expandedGapsByFileId}
          files={filteredFiles}
          pagerMode={pagerMode}
          screenLeft={diffPaneScreenLeft}
          screenTop={diffPaneScreenTop}
          showTopChrome={showMenuBar && !pagerMode}
          headerLabelWidth={diffHeaderLabelWidth}
          headerStatsWidth={diffHeaderStatsWidth}
          layout={resolvedLayout}
          scrollRef={diffScrollRef}
          selectedFileId={selectedFile?.id}
          selectedHunkIndex={selectedHunkIndex}
          scrollToNote={review.scrollToNote}
          draftNote={review.draftNote}
          draftNoteFocused={focusArea === "note"}
          separatorWidth={diffSeparatorWidth}
          showAgentNotes={showAgentNotes}
          showLineNumbers={showLineNumbers}
          showHunkHeaders={showHunkHeaders}
          sourceStatusByFileId={review.sourceStatusByFileId}
          wrapLines={wrapLines}
          wrapToggleScrollTop={wrapToggleScrollTopRef.current}
          layoutToggleScrollTop={layoutToggleScrollTopRef.current}
          layoutToggleRequestId={layoutToggleRequestId}
          selectedFileTopAlignRequestId={review.selectedFileTopAlignRequestId}
          selectedHunkRevealRequestId={review.selectedHunkRevealRequestId}
          theme={activeTheme}
          width={diffPaneWidth}
          onActiveAddNoteAffordanceChange={setActiveAddNoteTarget}
          onRemoveUserNote={review.removeUserNote}
          onSaveDraftNote={saveDraftNote}
          onStartUserNoteAtHunk={startUserNote}
          onUpdateDraftNote={review.updateDraftNote}
          onBlurDraftNote={blurDraftNote}
          onCancelDraftNote={cancelDraftNote}
          onFocusDraftNote={focusDraftNote}
          onScrollCodeHorizontally={(delta) => {
            scrollCodeHorizontally(delta * FAST_CODE_HORIZONTAL_SCROLL_COLUMNS);
          }}
          onCopyFeedback={showTransientNotice}
          onSelectFile={jumpToFile}
          onToggleGap={review.toggleGap}
          onViewportCenteredHunkChange={(fileId, hunkIndex) =>
            review.selectHunk(fileId, hunkIndex, { preserveViewport: true })
          }
        />
      </box>

      {!pagerMode &&
      (focusArea === "filter" ||
        Boolean(review.filter) ||
        Boolean(sessionNoticeText ?? transientNoticeText ?? noticeText)) ? (
        <StatusBar
          filter={review.filter}
          filterFocused={focusArea === "filter"}
          noticeText={sessionNoticeText ?? transientNoticeText ?? noticeText ?? undefined}
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
            top={showMenuBar ? 1 : 0}
            terminalWidth={terminal.width}
            theme={baseTheme}
            onHoverItem={setActiveMenuItemIndex}
            onSelectItem={(entry) => {
              entry.action();
              closeMenu();
            }}
          />
        </Suspense>
      ) : null}

      {!pagerMode && showAgentSkill ? (
        <Suspense fallback={null}>
          <LazyAgentSkillDialog
            copySupported={renderer.isOsc52Supported?.() ?? false}
            terminalHeight={terminal.height}
            terminalWidth={terminal.width}
            theme={baseTheme}
            onClose={closeAgentSkill}
            onCopyPrompt={copyAgentSkillPrompt}
          />
        </Suspense>
      ) : null}

      {!pagerMode && showHelp ? (
        <Suspense fallback={null}>
          <LazyHelpDialog
            canRefresh={canRefreshCurrentInput}
            terminalHeight={terminal.height}
            terminalWidth={terminal.width}
            theme={baseTheme}
            onClose={closeHelp}
          />
        </Suspense>
      ) : null}

      {!pagerMode && themeSelectorState.open ? (
        <Suspense fallback={null}>
          <LazyThemeSelectorDialog
            items={themeSelectorItems}
            selectedIndex={themeSelectorState.selectedIndex}
            terminalHeight={terminal.height}
            terminalWidth={terminal.width}
            theme={baseTheme}
            onClose={closeThemeSelector}
            onPickItem={pickThemeSelectorItem}
            onScroll={moveThemeSelector}
          />
        </Suspense>
      ) : null}
    </box>
  );
}

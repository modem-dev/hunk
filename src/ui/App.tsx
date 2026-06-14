import {
  MouseButton,
  type MouseEvent as TuiMouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, lazy, onCleanup, Show, Suspense } from "solid-js";
import type { AppBootstrap, CliInput, LayoutMode, UserNoteLineTarget } from "../core/types";
import { canReloadInput, computeWatchSignature } from "../core/watch";
import type { HunkSessionBrokerClient, ReloadedSessionResult } from "../hunk-session/types";
import { MenuBar } from "./components/chrome/MenuBar";
import { StatusBar } from "./components/chrome/StatusBar";
import { DiffPane } from "./components/panes/DiffPane";
import { PaneDivider } from "./components/panes/PaneDivider";
import { SidebarPane } from "./components/panes/SidebarPane";
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
export function App(props: {
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

  const onQuit = props.onQuit ?? (() => process.exit(0));
  // Derived from bootstrap so a soft reload (new changeset, same App) recomputes it.
  const pagerMode = createMemo(() => Boolean(props.bootstrap.input.options.pager));
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();

  // Mutable ref containers (was useRef). Scroll/cancel refs are shared with panes via props.
  const sidebarScrollRef: { current: ScrollBoxRenderable | null } = { current: null };
  const diffScrollRef: { current: ScrollBoxRenderable | null } = { current: null };
  const cancelCopySelectionRef: { current: (() => void) | null } = { current: null };
  const sessionNoticeTimeoutRef: { current: ReturnType<typeof setTimeout> | null } = {
    current: null,
  };
  const transientTimerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };

  const [layoutToggleRequestId, setLayoutToggleRequestId] = createSignal(0);
  const [transientNoticeText, setTransientNoticeText] = createSignal<string | null>(null);
  const [layoutMode, setLayoutMode] = createSignal<LayoutMode>(props.bootstrap.initialMode);
  const [themeId, setThemeId] = createSignal(
    resolveTheme(
      props.bootstrap.initialTheme,
      props.bootstrap.initialThemeMode ?? renderer.themeMode,
      props.bootstrap.customTheme,
    ).id,
  );
  // Soft reloads replace bootstrap without re-running startup terminal theme detection.
  const detectedThemeMode = props.bootstrap.initialThemeMode;
  const [showAgentNotes, setShowAgentNotes] = createSignal(
    props.bootstrap.initialShowAgentNotes ?? false,
  );
  const [showLineNumbers, setShowLineNumbers] = createSignal(
    props.bootstrap.initialShowLineNumbers ?? true,
  );
  const [wrapLines, setWrapLines] = createSignal(props.bootstrap.initialWrapLines ?? false);
  const [copyDecorations, setCopyDecorations] = createSignal(
    props.bootstrap.initialCopyDecorations ?? false,
  );
  const [codeHorizontalOffset, setCodeHorizontalOffset] = createSignal(0);
  const [showHunkHeaders, setShowHunkHeaders] = createSignal(
    props.bootstrap.initialShowHunkHeaders ?? true,
  );
  const [sidebarVisible, setSidebarVisible] = createSignal(!pagerMode());
  const [forceSidebarOpen, setForceSidebarOpen] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);
  const [focusArea, setFocusArea] = createSignal<FocusArea>("files");
  const [activeAddNoteTarget, setActiveAddNoteTarget] = createSignal<ActiveAddNoteTarget | null>(
    null,
  );
  const [sidebarWidth, setSidebarWidth] = createSignal(34);
  const [resizeDragOriginX, setResizeDragOriginX] = createSignal<number | null>(null);
  const [resizeStartWidth, setResizeStartWidth] = createSignal<number | null>(null);
  const [sessionNoticeText, setSessionNoticeText] = createSignal<string | null>(null);
  // Scroll-position snapshots captured at the moment of a wrap/layout toggle. Signals (not refs)
  // so DiffPane sees the fresh value alongside the paired wrapLines/requestId change.
  const [wrapToggleScrollTop, setWrapToggleScrollTop] = createSignal<number | null>(null);
  const [layoutToggleScrollTop, setLayoutToggleScrollTop] = createSignal<number | null>(null);

  const themeOptions = createMemo(() => availableThemes(props.bootstrap.customTheme));
  const baseTheme = createMemo(() =>
    resolveTheme(themeId(), detectedThemeMode ?? null, props.bootstrap.customTheme),
  );
  const activeTheme = createMemo(() =>
    props.bootstrap.input.options.transparentBackground
      ? withTransparentBackground(baseTheme())
      : baseTheme(),
  );

  // Pass an accessor so soft reloads (new changeset, same App instance) re-derive review state.
  const review = useReviewController({ files: () => props.bootstrap.changeset.files });
  const filteredFiles = review.visibleFiles;
  const selectedFile = review.selectedFile;
  const selectedHunkIndex = review.selectedHunkIndex;
  const moveToAnnotatedFile = review.moveToAnnotatedFile;
  const moveToAnnotatedHunk = review.moveToAnnotatedHunk;
  const moveToFile = review.moveToFile;

  const jumpToFile = (
    fileId: string,
    nextHunkIndex = 0,
    options?: { alignFileHeaderTop?: boolean },
  ) => {
    review.selectFile(fileId, nextHunkIndex, {
      alignFileHeaderTop: options?.alignFileHeaderTop,
    });
  };

  const openAgentNotes = () => {
    setShowAgentNotes(true);
  };

  const showSessionNotice = (message: string) => {
    setSessionNoticeText(message);
    if (sessionNoticeTimeoutRef.current) {
      clearTimeout(sessionNoticeTimeoutRef.current);
    }

    sessionNoticeTimeoutRef.current = setTimeout(() => {
      setSessionNoticeText((current) => (current === message ? null : current));
      sessionNoticeTimeoutRef.current = null;
    }, 4000);
  };

  onCleanup(() => {
    if (sessionNoticeTimeoutRef.current) {
      clearTimeout(sessionNoticeTimeoutRef.current);
    }
  });

  useHunkSessionBridge({
    addLiveComment: review.addLiveComment,
    addLiveCommentBatch: review.addLiveCommentBatch,
    clearLiveComments: review.clearLiveComments,
    hostClient: props.hostClient,
    liveCommentCount: review.liveCommentCount,
    liveCommentSummaries: review.liveCommentSummaries,
    navigateToLocation: review.navigateToLocation,
    openAgentNotes,
    reloadSession: props.onReloadSession,
    removeLiveComment: review.removeLiveComment,
    reviewNoteCount: review.reviewNoteCount,
    reviewNoteSummaries: review.reviewNoteSummaries,
    selectedFile,
    selectedHunk: review.selectedHunk,
    selectedHunkIndex,
    showAgentNotes,
  });

  // Layout geometry — all reactive (terminal dimensions, layout mode, sidebar state).
  const bodyPadding = () => (pagerMode() ? 0 : BODY_PADDING);
  const bodyWidth = () => Math.max(0, terminal().width - bodyPadding());
  const responsiveLayout = createMemo(() =>
    resolveResponsiveLayout(layoutMode(), terminal().width),
  );
  const canForceShowSidebar = () =>
    bodyWidth() >= SIDEBAR_MIN_WIDTH + DIVIDER_WIDTH + DIFF_MIN_WIDTH;
  const renderSidebar = () =>
    sidebarVisible() &&
    (responsiveLayout().showSidebar || (forceSidebarOpen() && canForceShowSidebar()));
  const centerWidth = () => bodyWidth();
  const resolvedLayout = () => responsiveLayout().layout;
  const availableCenterWidth = () =>
    renderSidebar() ? Math.max(0, centerWidth() - DIVIDER_WIDTH) : Math.max(0, centerWidth());
  const maxSidebarWidth = () =>
    renderSidebar()
      ? Math.max(SIDEBAR_MIN_WIDTH, availableCenterWidth() - DIFF_MIN_WIDTH)
      : SIDEBAR_MIN_WIDTH;
  const clampedSidebarWidth = () =>
    renderSidebar() ? clamp(sidebarWidth(), SIDEBAR_MIN_WIDTH, maxSidebarWidth()) : 0;
  const diffPaneWidth = () =>
    renderSidebar()
      ? Math.max(DIFF_MIN_WIDTH, availableCenterWidth() - clampedSidebarWidth())
      : Math.max(0, availableCenterWidth());
  const diffContentWidth = () => Math.max(12, diffPaneWidth() - 2);
  const maxVisibleLineNumber = createMemo(() =>
    filteredFiles().reduce(
      (maxLineNumber, file) => Math.max(maxLineNumber, findMaxLineNumber(file)),
      1,
    ),
  );
  const maxLineNumberDigits = () => String(maxVisibleLineNumber()).length;
  const codeViewportWidth = createMemo(() =>
    resolveCodeViewportWidth(
      resolvedLayout(),
      diffContentWidth(),
      maxLineNumberDigits(),
      showLineNumbers(),
    ),
  );
  const isResizingSidebar = () => resizeDragOriginX() !== null && resizeStartWidth() !== null;
  const dividerHitLeft = () =>
    Math.max(1, 1 + clampedSidebarWidth() - Math.floor((DIVIDER_HIT_WIDTH - DIVIDER_WIDTH) / 2));

  createEffect(() => {
    if (!renderSidebar()) {
      setResizeDragOriginX(null);
      setResizeStartWidth(null);
      return;
    }

    setSidebarWidth((current) => clamp(current, SIDEBAR_MIN_WIDTH, maxSidebarWidth()));
  });

  createEffect(() => {
    // Force an intermediate redraw when app geometry or row-wrapping changes so pane relayout
    // feels immediate after toggling split/stack or line wrapping.
    void renderSidebar();
    void resolvedLayout();
    void terminal().height;
    void terminal().width;
    void wrapLines();
    renderer.intermediateRender();
  });

  createEffect(() => {
    const file = selectedFile();
    if (!file) {
      return;
    }

    sidebarScrollRef.current?.scrollChildIntoView(fileRowId(file.id));
  });

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

  const maxCodeHorizontalOffset = createMemo(() =>
    Math.max(
      0,
      filteredFiles().reduce(
        (maxWidth, file) => Math.max(maxWidth, maxFileCodeLineWidth(file)),
        0,
      ) - codeViewportWidth(),
    ),
  );

  createEffect(() => {
    const limit = maxCodeHorizontalOffset();
    setCodeHorizontalOffset((current) => clamp(current, 0, limit));
  });

  /** Shift the visible code columns horizontally without moving gutters or headers. */
  const scrollCodeHorizontally = (delta: number) => {
    if (wrapLines() || delta === 0 || maxCodeHorizontalOffset() <= 0) {
      return;
    }

    setCodeHorizontalOffset((current) => clamp(current + delta, 0, maxCodeHorizontalOffset()));
  };

  /** Preserve the current review position before changing the active diff layout. */
  const selectLayoutMode = (mode: LayoutMode) => {
    setLayoutToggleScrollTop(diffScrollRef.current?.scrollTop ?? 0);
    setLayoutToggleRequestId((current) => current + 1);
    setLayoutMode(mode);
  };

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
  // otherwise be invisible to the user (OSC52 unsupported, etc.). Track the timer so we can clear
  // it on dispose and avoid state updates after the tree is gone.
  const showTransientNotice = (text: string, durationMs = 3000) => {
    if (transientTimerRef.current !== null) {
      clearTimeout(transientTimerRef.current);
    }
    setTransientNoticeText(text);
    transientTimerRef.current = setTimeout(() => {
      transientTimerRef.current = null;
      setTransientNoticeText((current) => (current === text ? null : current));
    }, durationMs);
  };

  // Clear any pending transient-notice timer on dispose to avoid state updates after teardown.
  onCleanup(() => {
    if (transientTimerRef.current !== null) {
      clearTimeout(transientTimerRef.current);
    }
  });

  /** Toggle whether diff code rows wrap instead of truncating to one terminal row. */
  const toggleLineWrap = () => {
    // Capture the pre-toggle viewport position synchronously so DiffPane can restore the same
    // top-most source row after wrapped row heights change.
    setWrapToggleScrollTop(diffScrollRef.current?.scrollTop ?? 0);
    setCodeHorizontalOffset(0);
    setWrapLines((current) => !current);
  };

  /** Switch the active theme and surface the result in the shared footer notice area. */
  const selectTheme = (nextThemeId: string) => {
    const nextTheme = themeOptions().find((theme) => theme.id === nextThemeId);
    setThemeId(nextThemeId);
    showTransientNotice(`Theme: ${nextTheme?.label ?? nextThemeId}`);
  };

  /** Toggle the sidebar, forcing it open on narrower layouts when the app can still fit both panes. */
  const toggleSidebar = () => {
    if (sidebarVisible() && (responsiveLayout().showSidebar || forceSidebarOpen())) {
      setSidebarVisible(false);
      setForceSidebarOpen(false);
      return;
    }

    if (sidebarVisible() && !responsiveLayout().showSidebar) {
      if (canForceShowSidebar()) {
        setForceSidebarOpen(true);
      }
      return;
    }

    setSidebarVisible(true);
    setForceSidebarOpen(!responsiveLayout().showSidebar && canForceShowSidebar());
  };

  /** Toggle visibility of hunk metadata rows without changing the actual diff lines. */
  const toggleHunkHeaders = () => {
    setShowHunkHeaders((current) => !current);
  };

  const canRefreshCurrentInput = () => canReloadInput(props.bootstrap.input);
  const watchEnabled = () =>
    Boolean(props.bootstrap.input.options.watch && canRefreshCurrentInput());

  /** Rebuild the current diff source while preserving the active app view options. */
  const refreshCurrentInput = async () => {
    if (!canRefreshCurrentInput()) {
      return;
    }

    const nextInput = withCurrentViewOptions(props.bootstrap.input, {
      layoutMode: layoutMode(),
      themeId: themeId(),
      showAgentNotes: showAgentNotes(),
      showHunkHeaders: showHunkHeaders(),
      showLineNumbers: showLineNumbers(),
      wrapLines: wrapLines(),
    });

    await props.onReloadSession(nextInput, {
      resetApp: false,
      sourcePath:
        props.bootstrap.input.kind === "vcs" ||
        props.bootstrap.input.kind === "show" ||
        props.bootstrap.input.kind === "stash-show"
          ? props.bootstrap.changeset.sourceLabel
          : undefined,
    });
  };

  const triggerRefreshCurrentInput = () => {
    void refreshCurrentInput().catch((error) => {
      console.error("Failed to reload the current diff.", error);
    });
  };

  const triggerEditSelectedFile = () => {
    const basePath =
      props.bootstrap.input.kind === "vcs" ||
      props.bootstrap.input.kind === "show" ||
      props.bootstrap.input.kind === "stash-show"
        ? props.bootstrap.changeset.sourceLabel
        : undefined;
    const message = openSelectedFileInEditor({
      basePath,
      file: selectedFile(),
      renderer,
      selectedHunk: review.selectedHunk(),
    });

    if (message) {
      showSessionNotice(message);
      return;
    }

    if (canRefreshCurrentInput()) {
      triggerRefreshCurrentInput();
    }
  };

  createEffect(() => {
    if (!watchEnabled()) {
      return;
    }

    let cancelled = false;
    let polling = false;
    let refreshing = false;
    let lastSignature: string;

    try {
      lastSignature = computeWatchSignature(props.bootstrap.input);
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
        const nextSignature = computeWatchSignature(props.bootstrap.input);
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
    onCleanup(() => {
      cancelled = true;
      clearInterval(interval);
    });
  });

  /** Leave the app through the shared shutdown path. */
  const requestQuit = () => {
    onQuit();
  };

  /** Close the modal keyboard help overlay. */
  const closeHelp = () => {
    setShowHelp(false);
  };

  /** Toggle the modal keyboard help overlay. */
  const toggleHelp = () => {
    setShowHelp((current) => !current);
  };

  /** Focus the file list/sidebar navigation area. */
  const focusFiles = () => {
    setFocusArea("files");
  };

  /** Focus the file filter input in the status bar. */
  const focusFilter = () => {
    setFocusArea("filter");
  };

  /** Toggle keyboard focus between the file list and the file filter. */
  const toggleFocusArea = () => {
    setFocusArea((current) => (current === "files" ? "filter" : "files"));
  };

  /** Start a user-authored inline note and move keyboard focus into it. */
  const startUserNote = (fileId?: string, hunkIndex?: number, target?: UserNoteLineTarget) => {
    const hoverTarget = fileId === undefined ? activeAddNoteTarget() : null;
    const draft = review.startUserNote(
      fileId ?? hoverTarget?.fileId,
      hunkIndex ?? hoverTarget?.hunkIndex,
      target ?? hoverTarget?.target,
    );
    if (draft) {
      setActiveAddNoteTarget(null);
      setFocusArea("note");
    }
  };

  /** Mark the inline draft note textarea as the active keyboard input. */
  const focusDraftNote = () => {
    setFocusArea("note");
  };

  /** Return keyboard focus to review navigation when the draft textarea loses focus. */
  const blurDraftNote = () => {
    setFocusArea((current) => (current === "note" ? "files" : current));
  };

  /** Save the active draft note and return focus to review navigation. */
  const saveDraftNote = () => {
    review.saveDraftNote();
    setFocusArea("files");
  };

  /** Cancel the active draft note and return focus to review navigation. */
  const cancelDraftNote = () => {
    review.cancelDraftNote();
    setFocusArea("files");
  };

  /** Cycle through the themes exposed by the current app configuration. */
  const cycleTheme = () => {
    const options = themeOptions();
    const currentIndex = options.findIndex((theme) => theme.id === activeTheme().id);
    const nextIndex = (currentIndex + 1) % options.length;
    selectTheme(options[nextIndex]!.id);
  };

  const menus = createMemo(() =>
    buildAppMenus({
      activeThemeId: activeTheme().id,
      availableThemes: themeOptions(),
      canRefreshCurrentInput: canRefreshCurrentInput(),
      focusFilter,
      layoutMode: layoutMode(),
      moveToAnnotatedFile,
      moveToAnnotatedHunk,
      moveToHunk: review.moveToHunk,
      refreshCurrentInput: triggerRefreshCurrentInput,
      requestQuit,
      selectLayoutMode,
      selectThemeId: selectTheme,
      copyDecorations: copyDecorations(),
      showAgentNotes: showAgentNotes(),
      showHelp: showHelp(),
      showHunkHeaders: showHunkHeaders(),
      showLineNumbers: showLineNumbers(),
      renderSidebar: renderSidebar(),
      toggleCopyDecorations,
      toggleAgentNotes,
      toggleFocusArea,
      toggleHelp,
      toggleHunkHeaders,
      toggleLineNumbers,
      toggleLineWrap,
      toggleSidebar,
      triggerEditSelectedFile,
      wrapLines: wrapLines(),
    }),
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
    cancelDraftNote,
    focusArea,
    focusFilter,
    moveToAnnotatedHunk,
    moveToFile,
    moveToHunk: review.moveToHunk,
    moveMenuItem,
    openMenu,
    pagerMode,
    requestQuit,
    scrollCodeHorizontally,
    saveDraftNote,
    scrollDiff,
    selectLayoutMode,
    showHelp,
    startUserNote: () => startUserNote(),
    switchMenu,
    toggleAgentNotes,
    toggleFocusArea,
    toggleGapForSelectedHunk: review.toggleSelectedHunkGap,
    toggleHelp,
    toggleHunkHeaders,
    toggleLineNumbers,
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
    setResizeStartWidth(clampedSidebarWidth());
    event.preventDefault();
    event.stopPropagation();
  };

  /** Update the sidebar width while a drag resize is active. */
  const updateSidebarResize = (event: TuiMouseEvent) => {
    const originX = resizeDragOriginX();
    const startWidth = resizeStartWidth();
    if (!isResizingSidebar() || originX === null || startWidth === null) {
      return;
    }

    setSidebarWidth(
      resizeSidebarWidth(startWidth, originX, event.x, SIDEBAR_MIN_WIDTH, maxSidebarWidth()),
    );
    event.preventDefault();
    event.stopPropagation();
  };

  /** End the current sidebar resize interaction. */
  const endSidebarResize = (event?: TuiMouseEvent) => {
    if (!isResizingSidebar()) {
      return;
    }

    setResizeDragOriginX(null);
    setResizeStartWidth(null);
    event?.preventDefault();
    event?.stopPropagation();
  };

  const totalAdditions = () =>
    props.bootstrap.changeset.files.reduce((sum, file) => sum + file.stats.additions, 0);
  const totalDeletions = () =>
    props.bootstrap.changeset.files.reduce((sum, file) => sum + file.stats.deletions, 0);
  const topTitle = () =>
    `${props.bootstrap.changeset.title}  +${totalAdditions()}  -${totalDeletions()}`;
  const sidebarTextWidth = () => Math.max(8, clampedSidebarWidth() - 2);
  const diffHeaderStatsWidth = () => Math.min(24, Math.max(16, Math.floor(diffContentWidth() / 3)));
  const diffHeaderLabelWidth = () => Math.max(8, diffContentWidth() - diffHeaderStatsWidth() - 1);
  const diffSeparatorWidth = () => Math.max(4, diffContentWidth() - 2);
  // Mirror the App layout: bodyPadding/2 left-padding, then sidebar + divider when visible. Keep
  // this in lockstep with the body container's paddingLeft and the sidebar render branch below.
  const diffPaneScreenLeft = () =>
    bodyPadding() / 2 + (renderSidebar() ? clampedSidebarWidth() + DIVIDER_WIDTH : 0);
  const diffPaneScreenTop = () => (pagerMode() ? 0 : 1);

  const showStatusBar = () =>
    !pagerMode() &&
    (focusArea() === "filter" ||
      Boolean(review.filter()) ||
      Boolean(sessionNoticeText() ?? transientNoticeText() ?? props.noticeText));

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: activeTheme().background,
      }}
    >
      <Show when={!pagerMode()}>
        <MenuBar
          activeMenuId={activeMenuId()}
          menuSpecs={menuSpecs}
          terminalWidth={terminal().width}
          theme={activeTheme()}
          topTitle={topTitle()}
          onHoverMenu={(menuId) => {
            if (activeMenuId()) {
              openMenu(menuId);
            }
          }}
          onToggleMenu={toggleMenu}
        />
      </Show>

      <box
        style={{
          flexGrow: 1,
          flexDirection: "row",
          gap: 0,
          paddingLeft: bodyPadding() / 2,
          paddingRight: bodyPadding() / 2,
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
        <Show when={renderSidebar()}>
          <SidebarPane
            entries={review.sidebarEntries()}
            scrollRef={sidebarScrollRef}
            selectedFileId={selectedFile()?.id}
            textWidth={sidebarTextWidth()}
            theme={activeTheme()}
            width={clampedSidebarWidth()}
            estimatedViewportRows={terminal().height}
            onSelectFile={(fileId) => {
              focusFiles();
              jumpToFile(fileId, 0, { alignFileHeaderTop: true });
            }}
          />

          <PaneDivider
            dividerHitLeft={dividerHitLeft()}
            dividerHitWidth={DIVIDER_HIT_WIDTH}
            isResizing={isResizingSidebar()}
            theme={activeTheme()}
            onMouseDown={beginSidebarResize}
            onMouseDrag={updateSidebarResize}
            onMouseDragEnd={endSidebarResize}
            onMouseUp={endSidebarResize}
          />
        </Show>

        <DiffPane
          cancelCopySelectionRef={cancelCopySelectionRef}
          codeHorizontalOffset={codeHorizontalOffset()}
          copyDecorations={copyDecorations()}
          diffContentWidth={diffContentWidth()}
          expandedGapsByFileId={review.expandedGapsByFileId}
          files={filteredFiles}
          pagerMode={pagerMode()}
          screenLeft={diffPaneScreenLeft()}
          screenTop={diffPaneScreenTop()}
          headerLabelWidth={diffHeaderLabelWidth()}
          headerStatsWidth={diffHeaderStatsWidth()}
          layout={resolvedLayout()}
          scrollRef={diffScrollRef}
          selectedFileId={() => selectedFile()?.id}
          selectedHunkIndex={selectedHunkIndex}
          scrollToNote={review.scrollToNote}
          draftNote={review.draftNote}
          draftNoteFocused={focusArea() === "note"}
          separatorWidth={diffSeparatorWidth()}
          showAgentNotes={showAgentNotes}
          showLineNumbers={showLineNumbers()}
          showHunkHeaders={showHunkHeaders()}
          sourceStatusByFileId={review.sourceStatusByFileId}
          wrapLines={wrapLines()}
          wrapToggleScrollTop={wrapToggleScrollTop()}
          layoutToggleScrollTop={layoutToggleScrollTop()}
          layoutToggleRequestId={layoutToggleRequestId()}
          selectedFileTopAlignRequestId={review.selectedFileTopAlignRequestId}
          selectedHunkRevealRequestId={review.selectedHunkRevealRequestId}
          theme={activeTheme()}
          width={diffPaneWidth()}
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

      <Show when={showStatusBar()}>
        <StatusBar
          filter={review.filter()}
          filterFocused={focusArea() === "filter"}
          noticeText={sessionNoticeText() ?? transientNoticeText() ?? props.noticeText ?? undefined}
          terminalWidth={terminal().width}
          theme={activeTheme()}
          onCloseMenu={closeMenu}
          onFilterInput={review.setFilter}
          onFilterSubmit={focusFiles}
        />
      </Show>

      <Show when={!pagerMode() && activeMenuId() && activeMenuSpec()}>
        <Suspense fallback={null}>
          <LazyMenuDropdown
            activeMenuId={activeMenuId()!}
            activeMenuEntries={activeMenuEntries()}
            activeMenuItemIndex={activeMenuItemIndex()}
            activeMenuSpec={activeMenuSpec()!}
            activeMenuWidth={activeMenuWidth()}
            terminalWidth={terminal().width}
            theme={baseTheme()}
            onHoverItem={setActiveMenuItemIndex}
            onSelectItem={(entry) => {
              entry.action();
              closeMenu();
            }}
          />
        </Suspense>
      </Show>

      <Show when={!pagerMode() && showHelp()}>
        <Suspense fallback={null}>
          <LazyHelpDialog
            canRefresh={canRefreshCurrentInput()}
            terminalHeight={terminal().height}
            terminalWidth={terminal().width}
            theme={baseTheme()}
            onClose={closeHelp}
          />
        </Suspense>
      </Show>
    </box>
  );
}

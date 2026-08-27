import {
  MouseButton,
  type MouseEvent as TuiMouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PersistedViewPreferences } from "../core/run/config";
import { experimentalFeatureEnabled, resolveExperimentalDiffFiles } from "../core/run/experimental";
import { DEFAULT_TAB_WIDTH } from "../core/run/tabWidth";
import { isVcsReviewInput } from "../core/vcs";
import type { AppBootstrap } from "../core/bootstrap";
import type { CliInput, CursorLine, LayoutMode } from "../core/run/commandInputs";
import { sanitizeTerminalLine } from "../lib/terminalText";
import {
  resolveExtensionCommands,
  resolveExtensionFileViews,
  resolveExtensionKeyboardModes,
  resolveExtensionLineHighlighters,
  resolveExtensionSessionOptions,
} from "../extensions/apply";
import {
  emitExtensionCustomEvent,
  emitExtensionEvent,
  toReadOnlyFileViews,
} from "../extensions/events";
import { buildExtensionReviewSnapshot } from "../extensions/reviewSnapshot";
import { writeExtensionTrust } from "../extensions/trust";
import type {
  ExtensionCommandContext,
  ExtensionEventContext,
  ExtensionNotifyType,
  ExtensionPaneControls,
  ExtensionLoadResult,
  RegisteredCommand,
  RegisteredPane,
} from "../extensions/types";
import type { ReviewProducer } from "../app/review/producer";
import type { HunkSessionBrokerClient } from "../session/broker/brokerClient";
import type { ReloadedSessionResult, ReloadSessionOptions } from "../session/types";
import { MenuBar } from "./components/chrome/MenuBar";
import { ConfirmDialog, confirmDialogHeight } from "./components/chrome/ConfirmDialog";
import { ExtensionDialog } from "./components/chrome/ExtensionDialog";
import { ExtensionToast } from "./components/chrome/ExtensionToast";
import { StatusBar } from "./components/chrome/StatusBar";
import { DiffPane } from "./components/panes/DiffPane";
import { ExtensionPaneHost } from "./components/panes/ExtensionPane";
import { PaneDivider } from "./components/panes/PaneDivider";
import {
  findMaxLineNumber,
  maxFileCodeLineWidth,
  resolveCodeViewportWidth,
} from "./diff/codeColumns";
import { useAppKeyboardShortcuts } from "./hooks/useAppKeyboardShortcuts";
import { useCurrentReviewRefreshController } from "./hooks/useCurrentReviewRefreshController";
import { useExtensionDialogController } from "./hooks/useExtensionDialogController";
import { useExtensionNotifications } from "./hooks/useExtensionNotifications";
import {
  useExtensionWorkspaceControls,
  type WorkspaceFileWriter,
  type WorkspaceWriteRunner,
} from "./hooks/useExtensionWorkspaceControls";
import { useHunkSessionBridge } from "./hooks/useHunkSessionBridge";
import { useMenuController } from "./hooks/useMenuController";
import { useThemeSelectorController } from "./hooks/useThemeSelectorController";
import { useTimedNotice } from "./hooks/useTimedNotice";
import { useUserNoteComposer, type UserNoteEventPublisher } from "./hooks/useUserNoteComposer";
import {
  useTerminalReview,
  type AgentNoteGeometrySnapshot,
  type RevealedLineResult,
} from "./hooks/useTerminalReview";
import { useViewPreferenceQuitController } from "./hooks/useViewPreferenceQuitController";
import type { WatchedInputRuntime } from "./hooks/useWatchedInput";
import { agentNoteMarkupWidth } from "./lib/agentNoteGeometry";
import {
  buildAppCommands,
  builtinCommandKeyDefaults,
  builtinCommandMatchProbes,
  observeAppCommandDispatch,
  type AppCommand,
} from "./lib/appCommands";
import { buildAppMenus } from "./lib/appMenus";
import { buildExtensionAppCommands, extensionCommandKeyDefaults } from "./lib/extensionCommands";
import { createExtensionCapabilityLease } from "./lib/extensionCapabilityLease";
import { createExtensionCommandControls } from "./lib/extensionCommandControls";
import {
  applyExtensionCurrentLinePaintUpdate,
  extensionCurrentLinePaintMatchesCursor,
  type ExtensionCurrentLinePaintState,
  type ExtensionCurrentLinePaintUpdate,
} from "./lib/extensionCurrentLine";
import { createGuardedReviewNavigation } from "./lib/extensionNavigation";
import type { CurrentLineAlignment } from "./lib/hunkScroll";
import type { LineCursor } from "./lib/lineCursors";
import { buildExtensionReviewSelection } from "./lib/extensionSelection";
import { useFilePresentationController } from "./fileViews/useFilePresentationController";
import { useFilePresentationRendering } from "./fileViews/useFilePresentationRendering";
import { mergeLineHighlightMaps } from "./highlights/merge";
import { useLineHighlights } from "./highlights/useLineHighlights";
import { useLineHighlightsController } from "./highlights/useLineHighlightsController";
import { useKeyboardModeController } from "./keyboardModes/useKeyboardModeController";
import { createExtensionPaneKeybindings, resolveCommandKeys } from "./lib/keymap";
import {
  buildSessionPanes,
  EXTENSION_PANE_DIVIDER_SIZE,
  initialPaneOpenState,
  MIN_EXTENSION_REVIEW_HEIGHT,
  planExtensionPanes,
  reconcilePaneOpenState,
  resolvePaneKey,
  resolvePaneSlotKey,
  type PlannedPane,
} from "./lib/extensionPanes";
import type { ExtensionPanePlacement } from "../extension-api/types";
import { HUNK_FILES_PANE_KEY } from "../extensions/extensionIds";
import { extensionPaneSize } from "../extensions/panes";
import { nextExtensionTrustPromptRoot } from "./lib/extensionTrustPrompt";
import { maxFileHeaderStatsWidth } from "./lib/fileHeader";
import { openSelectedFileInEditor } from "./lib/openInEditor";
import { resolveResponsiveLayout } from "./lib/responsive";
import { resizeSidebarWidth } from "./lib/sidebar";
import type { WorkspaceRefreshRequest } from "./currentReviewRefresh";

type FocusArea = "files" | "filter" | "note";

const FAST_CODE_HORIZONTAL_SCROLL_COLUMNS = 8;

/**
 * Trailing debounce before one `selection_changed` event is emitted.
 *
 * Holding `[`/`]` or scrolling the review stream retargets the selection many
 * times a second; extension handlers only care where the user came to rest, so
 * intermediate selections are collapsed instead of dispatched.
 */
const SELECTION_CHANGED_DEBOUNCE_MS = 150;

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

/** Orchestrate global app state, layout, navigation, and pane coordination. */
export function App({
  bootstrap,
  hostClient,
  noticeText,
  onQuit = () => process.exit(0),
  onRegisterWorkspaceRefreshRequest,
  onReloadSession,
  onWorkspaceWriteCompleted,
  reviewProducer,
  runWorkspaceWrite,
  watchRuntime,
  workspaceFileWriter,
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkSessionBrokerClient;
  noticeText?: string | null;
  onQuit?: () => void;
  /** Register the mounted review descriptor AppHost should reconcile after a completed write. */
  onRegisterWorkspaceRefreshRequest: (request: WorkspaceRefreshRequest) => () => void;
  onReloadSession: (
    nextInput: CliInput,
    options?: ReloadSessionOptions,
  ) => Promise<ReloadedSessionResult>;
  /** Reconcile the currently mounted review after a consented filesystem write succeeds. */
  onWorkspaceWriteCompleted: () => void;
  /** The producer publishing this review's generations, when the host mounted one. */
  reviewProducer?: ReviewProducer;
  /** Start and track one irreversible write, or refuse it once graceful shutdown begins. */
  runWorkspaceWrite: WorkspaceWriteRunner;
  watchRuntime?: WatchedInputRuntime;
  workspaceFileWriter?: WorkspaceFileWriter;
}) {
  const SIDEBAR_MIN_WIDTH = 22;
  const DIFF_MIN_WIDTH = 48;
  const BODY_PADDING = 2;

  const pagerMode = Boolean(bootstrap.input.options.pager);
  const tabWidth = bootstrap.initialTabWidth ?? DEFAULT_TAB_WIDTH;
  const stmlEnabled = experimentalFeatureEnabled(bootstrap.input.options, "stml");
  const reviewFiles = useMemo(
    () => resolveExperimentalDiffFiles(bootstrap.changeset.files, bootstrap.input.options),
    [bootstrap.changeset.files, bootstrap.input.options.experimental],
  );
  // App computes layout geometry below this hook call, so the controller reads
  // the current values through a ref instead of a render-time parameter.
  const noteGeometryRef = useRef<AgentNoteGeometrySnapshot | null>(null);
  const [lineCursors, setLineCursors] = useState<LineCursor[]>([]);
  const review = useTerminalReview({
    files: reviewFiles,
    initialShowAgentNotes: bootstrap.initialShowAgentNotes ?? false,
    lineCursors,
    noteGeometry: noteGeometryRef,
    sourceLabel: bootstrap.changeset.sourceLabel,
    stmlEnabled,
  });
  // The producer plans brokered actions against the store this controller owns, so a
  // remote action and a key press reach the same state through the same intent path.
  // AppHost detaches the previous store while committing a reload; this child layout
  // effect installs the matching store before parent lifecycle handlers can use it.
  useLayoutEffect(() => {
    reviewProducer?.attachStore(review.store);
  }, [bootstrap.changeset, review.store, reviewProducer]);
  // Note-layer visibility is shared review state, so it lives in the review store
  // alongside the notes it governs rather than in local app state.
  const showAgentNotes = review.showAgentNotes;
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const wrapToggleScrollTopRef = useRef<number | null>(null);
  const layoutToggleScrollTopRef = useRef<number | null>(null);
  const cancelCopySelectionRef = useRef<(() => void) | null>(null);
  const [layoutToggleRequestId, setLayoutToggleRequestId] = useState(0);
  const { text: transientNoticeText, show: showTransientNotice } = useTimedNotice(3_000);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(bootstrap.initialMode);
  const [showLineNumbers, setShowLineNumbers] = useState(bootstrap.initialShowLineNumbers ?? true);
  const [wrapLines, setWrapLines] = useState(bootstrap.initialWrapLines ?? false);
  const [copyDecorations, setCopyDecorations] = useState(bootstrap.initialCopyDecorations ?? false);
  const [codeHorizontalOffset, setCodeHorizontalOffset] = useState(0);
  const [cursorLine, setCursorLine] = useState<CursorLine>(bootstrap.initialCursorLine ?? "row");
  const [lineCursorAlignmentRequest, setLineCursorAlignmentRequest] = useState<{
    id: number;
    alignment: CurrentLineAlignment;
  }>({ id: 0, alignment: "center" });
  const [showHunkHeaders, setShowHunkHeaders] = useState(bootstrap.initialShowHunkHeaders ?? true);
  const [showMenuBar, setShowMenuBar] = useState(bootstrap.initialShowMenuBar ?? true);
  const [sidebarVisible, setSidebarVisible] = useState(() => !pagerMode);
  const [forceSidebarOpen, setForceSidebarOpen] = useState(
    () => !pagerMode && bootstrap.initialSidebar === true,
  );
  const [showHelp, setShowHelp] = useState(false);
  const [showAgentSkill, setShowAgentSkill] = useState(false);
  const [focusArea, setFocusArea] = useState<FocusArea>("files");
  const [paneSizes, setPaneSizes] = useState<Record<string, number>>({});
  const [paneResize, setPaneResize] = useState<{
    key: string;
    registered: RegisteredPane;
    placement: ExtensionPanePlacement;
    origin: number;
    startSize: number;
    maxSize: number;
    minSize: number;
  } | null>(null);
  const { text: sessionNoticeText, show: showSessionNotice } = useTimedNotice(4_000);
  const extensions = bootstrap.extensions as ExtensionLoadResult | undefined;
  const sessionPanes = useMemo(() => buildSessionPanes(extensions), [extensions]);
  const [paneOpenState, setPaneOpenState] = useState(() => {
    const initial = initialPaneOpenState(sessionPanes);
    if (bootstrap.initialSidebar !== false) return initial;

    // The preference targets the active files slot, not independently open extension panes.
    const filesPaneKey = resolvePaneSlotKey({
      panes: sessionPanes,
      slotKey: HUNK_FILES_PANE_KEY,
      openKeys: initial.open,
    });
    return { ...initial, open: initial.open.filter((key) => key !== filesPaneKey) };
  });
  useEffect(
    () => setPaneOpenState((current) => reconcilePaneOpenState(sessionPanes, current)),
    [sessionPanes],
  );
  const sessionPanesRef = useRef(sessionPanes);
  sessionPanesRef.current = sessionPanes;
  const paneOpenStateRef = useRef(paneOpenState);
  paneOpenStateRef.current = paneOpenState;
  const currentLinePaintRequested = sessionPanes.some(
    (pane) => paneOpenState.open.includes(pane.key) && pane.registered.pane.currentLine === true,
  );
  const [currentLinePaintState, setCurrentLinePaintState] =
    useState<ExtensionCurrentLinePaintState>({
      status: "unavailable",
      fileId: null,
      cursorKey: null,
      paint: null,
    });
  const onCurrentLinePaintChange = useCallback((update: ExtensionCurrentLinePaintUpdate) => {
    setCurrentLinePaintState((current) => applyExtensionCurrentLinePaintUpdate(current, update));
  }, []);
  const retainedCurrentLinePaneKeysRef = useRef<ReadonlySet<string>>(new Set());
  const [paneFailureEpoch, setPaneFailureEpoch] = useState(0);
  const paneAvailabilityQuarantineRef = useRef(new WeakSet());
  const pendingTrustRepoRoot = extensions?.pendingTrustRepoRoot;
  const extensionToast = useExtensionNotifications(extensions?.notifications);
  // Repo-local extensions were discovered but skipped for want of a trust
  // decision. The prompt tracks the pending root reactively, because a session
  // reload can point this app at a different repository without remounting.
  const [extensionTrustPromptRoot, setExtensionTrustPromptRoot] = useState<string | null>(null);
  const offeredTrustRepoRootsRef = useRef<Set<string>>(new Set());
  const extensionTrustPromptOpen = extensionTrustPromptRoot !== null;

  const {
    activeTheme,
    baseTheme,
    themeId,
    themeSelectorItems,
    themeSelectorOpen,
    themeSelectorSelectedIndex,
    acceptThemeSelector,
    acceptThemeSelectorItem,
    closeThemeSelector,
    moveThemeSelector,
    openThemeSelector,
    previewThemeSelectorItem,
  } = useThemeSelectorController({
    customThemes: bootstrap.customThemes,
    initialTheme: bootstrap.initialTheme,
    initialThemeMode: bootstrap.initialThemeMode ?? renderer.themeMode,
    onTransientNotice: showTransientNotice,
    transparentBackground: bootstrap.input.options.transparentBackground ?? false,
  });
  const currentViewPreferences = useMemo<PersistedViewPreferences>(
    () => ({
      mode: layoutMode,
      theme: themeId,
      showLineNumbers,
      wrapLines,
      showHunkHeaders,
      showMenuBar,
      showAgentNotes,
      copyDecorations,
      cursorLine,
    }),
    [
      copyDecorations,
      cursorLine,
      layoutMode,
      showAgentNotes,
      showHunkHeaders,
      showLineNumbers,
      showMenuBar,
      themeId,
      wrapLines,
    ],
  );
  const filteredFiles = review.visibleFiles;
  const selectedFile = review.selectedFile;
  const selectedHunkIndex = review.selectedHunkIndex;
  const selectedFileId = selectedFile?.id ?? null;
  const currentLinePaintMatchesCursor = extensionCurrentLinePaintMatchesCursor(
    currentLinePaintState,
    review.lineCursor,
  );
  const currentLinePaint = currentLinePaintMatchesCursor ? currentLinePaintState.paint : null;
  const currentLinePaintPending =
    currentLinePaintState.status === "pending" ||
    (currentLinePaintState.status === "ready" && !currentLinePaintMatchesCursor);
  /** The review stream's current line, or null when line-level navigation is off. */
  const activeLineCursor = useMemo(
    () => (cursorLine === "off" ? null : review.lineCursor),
    [cursorLine, review.lineCursor],
  );
  const sessionFileViews = useMemo(
    () => (extensions ? resolveExtensionFileViews(extensions.registry).views : []),
    [extensions],
  );
  const sessionKeyboardModes = useMemo(
    () => (extensions ? resolveExtensionKeyboardModes(extensions.registry).modes : []),
    [extensions],
  );
  const sessionLineHighlighters = useMemo(
    () => (extensions ? resolveExtensionLineHighlighters(extensions.registry).highlighters : []),
    [extensions],
  );
  const extensionSessionOptions = useMemo(
    () =>
      extensions
        ? resolveExtensionSessionOptions(extensions.registry)
        : { transientViewPreferences: false },
    [extensions],
  );
  // The one conversion of the visible review files into the frozen views every
  // extension surface sees: sidebar props and command-handler selection both
  // read from this list, so they can never describe the review differently.
  // Computed on demand and cached per visible-files identity rather than
  // eagerly memoized: `visibleFiles` gets a fresh identity on every selection
  // change, so an eager memo would reconvert the whole list on each navigation
  // keypress even in sessions where no pane is showing and no command fires.
  const extensionViewsCacheRef = useRef<{
    source: typeof filteredFiles;
    views: ReturnType<typeof toReadOnlyFileViews>;
  } | null>(null);
  const extensionSelectionInputsRef = useRef({
    filteredFiles,
    getSelection: review.getSelection,
    getActiveLineCursor: () => (cursorLine === "off" ? null : review.getLineCursor()),
  });
  extensionSelectionInputsRef.current = {
    filteredFiles,
    getSelection: review.getSelection,
    getActiveLineCursor: () => (cursorLine === "off" ? null : review.getLineCursor()),
  };
  const getExtensionFileViews = useCallback(() => {
    const source = extensionSelectionInputsRef.current.filteredFiles;
    const cache = extensionViewsCacheRef.current;
    if (cache && cache.source === source) {
      return cache.views;
    }

    const views = toReadOnlyFileViews(source);
    extensionViewsCacheRef.current = { source, views };
    return views;
  }, []);
  // Navigation callbacks for extension command handlers. The focus and jump
  // helpers they delegate to are defined further down the component, so the
  // callbacks are assigned there each render and only ever read at command
  // invocation, keeping the dispatch table free of their identities.
  const extensionCommandNavigationRef = useRef({
    onSelectFile: (_fileId: string) => {},
    onSelectHunk: (_fileId: string, _hunkIndex: number) => {},
    onRevealLine: (_fileId: string, _side: "old" | "new", _line: number): RevealedLineResult =>
      "none",
  });
  // A hard session reload (`resetApp`) remounts App under an in-flight async
  // command handler, whose `ctx.navigation` closes over *this* instance's
  // refs. Flipping this on unmount lets those closures refuse with an accurate
  // warning instead of validating against the dead instance's file list or
  // driving a controller whose state updates no longer render.
  const appAliveForNavigationRef = useRef(true);
  const extensionHostCommandsRef = useRef<readonly AppCommand[]>([]);
  // A soft extension reload keeps App mounted but replaces the authority that
  // created each handler. Retain the current registry separately so controls
  // captured by a retired async handler cannot drive the replacement registry.
  const activeExtensionRegistryRef = useRef(extensions?.registry);
  const activeReviewGenerationRef = useRef(bootstrap);
  useLayoutEffect(() => {
    activeExtensionRegistryRef.current = extensions?.registry;
    activeReviewGenerationRef.current = bootstrap;
  }, [bootstrap, extensions?.registry]);
  const extensionCommandControls = useMemo(() => {
    const lease = createExtensionCapabilityLease({
      owningRegistry: extensions?.registry,
      getActiveRegistry: () => activeExtensionRegistryRef.current,
      isAppAlive: () => appAliveForNavigationRef.current,
    });
    return createExtensionCommandControls({
      getCommands: () => extensionHostCommandsRef.current,
      isLive: lease.isLive,
    });
  }, [extensions?.registry]);
  /** Mint controls that expire with their runtime, App instance, or review generation. */
  const createReviewCapabilityLease = useCallback(
    () =>
      createExtensionCapabilityLease({
        owningRegistry: extensions?.registry,
        getActiveRegistry: () => activeExtensionRegistryRef.current,
        isAppAlive: () => appAliveForNavigationRef.current,
        isReviewCurrent: () => activeReviewGenerationRef.current === bootstrap,
      }),
    [bootstrap, extensions?.registry],
  );
  useEffect(() => {
    // StrictMode replays setup/cleanup/setup while the same App remains mounted.
    appAliveForNavigationRef.current = true;
    return () => {
      appAliveForNavigationRef.current = false;
    };
  }, []);

  /** Build the selection snapshot a command handler receives, at invocation. */
  const getExtensionSelection = useCallback(() => {
    const { getSelection, getActiveLineCursor } = extensionSelectionInputsRef.current;
    const { fileId, hunkIndex } = getSelection();
    return buildExtensionReviewSelection({
      files: getExtensionFileViews(),
      selectedFileId: fileId,
      selectedHunkIndex: hunkIndex,
      lineCursor: getActiveLineCursor(),
    });
  }, [getExtensionFileViews]);
  /** Mint authoritative review snapshot controls for one extension command invocation. */
  const createExtensionReviewControls = useCallback(() => {
    const lease = createReviewCapabilityLease();
    return {
      snapshot() {
        if (!lease.isLive()) return null;
        const positioned = reviewProducer?.getPositionedReviewState();
        if (!positioned) return null;
        return buildExtensionReviewSnapshot(positioned.generation, positioned.state);
      },
    };
  }, [createReviewCapabilityLease, reviewProducer]);
  /** Read the live internal selection id independently from the frozen public selection. */
  const getSelectedFileId = useCallback(
    () => extensionSelectionInputsRef.current.getSelection().fileId,
    [],
  );
  const jumpToFile = useCallback(
    (fileId: string, options?: { alignFileHeaderTop?: boolean }) => {
      review.selectFile(fileId, { alignFileHeaderTop: options?.alignFileHeaderTop });
    },
    [review.selectFile],
  );

  const openAgentNotes = useCallback(() => {
    review.setShowAgentNotes(true);
  }, [review.setShowAgentNotes]);

  /** Close the modal keyboard help overlay. */
  const closeHelp = useCallback(() => {
    setShowHelp(false);
  }, []);
  const {
    changedViewPreferences,
    saveConfigPromptOpen,
    viewPreferenceDiffLines,
    viewPreferencesConfigLabel,
    requestQuit,
    saveViewPreferencesAndQuit,
    discardViewPreferencesAndQuit,
    neverAskToSaveViewPreferencesAndQuit,
    closeSaveConfigPrompt,
  } = useViewPreferenceQuitController({
    currentPreferences: currentViewPreferences,
    configPath: bootstrap.viewPreferencesConfigPath,
    pagerMode,
    promptSaveViewPreferences: bootstrap.input.options.promptSaveViewPreferences !== false,
    transientViewPreferences: extensionSessionOptions.transientViewPreferences,
    onQuit,
    showNotice: showSessionNotice,
    showError: showSessionNotice,
    closeHelp,
    homeDirectory: process.env.HOME,
  });
  const notifyExtensionMode = useCallback(
    (message: string, type?: ExtensionNotifyType) => extensions?.context.notify(message, type),
    [extensions],
  );
  const { epochs: lineHighlightEpochs, createControls: createLineHighlightControls } =
    useLineHighlightsController({
      files: reviewFiles,
      highlighters: sessionLineHighlighters,
      showNotice: showSessionNotice,
    });
  const {
    activeModeTitle: keyboardModeTitle,
    createControls: createKeyboardModeControls,
    exitMode: exitKeyboardMode,
    isModeActive: isKeyboardModeActive,
    modeStatusHint: keyboardModeHint,
    sendModeKey: sendKeyboardModeKey,
  } = useKeyboardModeController({
    commands: extensionCommandControls,
    createHighlightControls: createLineHighlightControls,
    cwd: extensions?.context.cwd ?? process.cwd(),
    modes: sessionKeyboardModes,
    notify: notifyExtensionMode,
    registry: extensions?.registry,
    showNotice: showSessionNotice,
  });

  const {
    applyBulkTarget: applyFilePresentationToAllMatching,
    availableSelections: availableFileViewSelectionState,
    epochs: fileViewEpochs,
    bulkTarget: selectedFileViewBulkTarget,
    createControls: createFileViewControls,
    menuEntries: selectedFileViewEntries,
    isModeActive: isFileViewModeActive,
    modeStatusHint: fileViewModeHint,
    exitMode: exitFileViewMode,
    sendModeKey: sendFileViewModeKey,
  } = useFilePresentationController({
    files: reviewFiles,
    visibleFiles: filteredFiles,
    selectedFile,
    draftFileId: review.draftNote?.fileId ?? null,
    views: sessionFileViews,
    getVisibleFileViews: getExtensionFileViews,
    getSelectedFileId,
    getExtensionSelection,
    showNotice: showSessionNotice,
    cwd: extensions?.context.cwd ?? process.cwd(),
    notify: notifyExtensionMode,
    reviewGeneration: bootstrap,
  });

  const setPaneOpen = useCallback((key: string, nextOpen: boolean | "toggle") => {
    setPaneOpenState((current) => {
      const isOpen = current.open.includes(key);
      const resolved = nextOpen === "toggle" ? !isOpen : nextOpen;
      if (resolved === isOpen) return current;
      return {
        known: current.known,
        open: resolved ? [...current.open, key] : current.open.filter((open) => open !== key),
      };
    });
  }, []);

  /** Build the canonical pane controls; deprecated sidebar controls share this object. */
  const createPaneControls = useCallback(
    (extensionId: string): ExtensionPaneControls => {
      const lease = createReviewCapabilityLease();
      const hasAuthority = (method: string) => {
        if (lease.isLive()) return true;
        extensions?.context.notify(
          `Extension ${extensionId} ${method} ignored — the review session was reloaded`,
          "warning",
        );
        return false;
      };
      const resolve = (method: string, id: string) => {
        const key = resolvePaneKey(sessionPanesRef.current, extensionId, id);
        if (!key)
          extensions?.context.notify(
            `Extension ${extensionId} ${method} targeted unknown pane "${id}"`,
            "warning",
          );
        return key;
      };
      const revealIfSide = (key: string) => {
        const pane = sessionPanesRef.current.find((entry) => entry.key === key);
        if (pane?.placement === "left" || pane?.placement === "right")
          revealSidebarAreaRef.current();
      };
      return {
        open(id) {
          if (!hasAuthority("panes.open")) return;
          const key = resolve("panes.open", id);
          if (key) {
            setPaneOpen(key, true);
            revealIfSide(key);
          }
        },
        close(id) {
          if (!hasAuthority("panes.close")) return;
          const key = resolve("panes.close", id);
          if (key) setPaneOpen(key, false);
        },
        toggle(id) {
          if (!hasAuthority("panes.toggle")) return;
          const key = resolve("panes.toggle", id);
          if (key) {
            const opens = !paneOpenStateRef.current.open.includes(key);
            setPaneOpen(key, "toggle");
            if (opens) revealIfSide(key);
          }
        },
        isOpen(id) {
          if (!lease.isLive()) return false;
          const key = resolvePaneKey(sessionPanesRef.current, extensionId, id);
          return key !== undefined && paneOpenStateRef.current.open.includes(key);
        },
      };
    },
    [createReviewCapabilityLease, extensions, setPaneOpen],
  );

  /** Build live, guarded review navigation for one extension-owned handler. */
  const createExtensionNavigation = useCallback(
    (extensionId: string) => {
      const lease = createReviewCapabilityLease();
      return createGuardedReviewNavigation({
        extensionId,
        getFiles: () => extensionSelectionInputsRef.current.filteredFiles,
        isLive: lease.isLive,
        notify: (message, type) => extensions?.context.notify(message, type),
        onSelectFile: (fileId) => extensionCommandNavigationRef.current.onSelectFile(fileId),
        onSelectHunk: (fileId, hunkIndex) =>
          extensionCommandNavigationRef.current.onSelectHunk(fileId, hunkIndex),
        onRevealLine: (fileId, side, line) =>
          extensionCommandNavigationRef.current.onRevealLine(fileId, side, line),
      });
    },
    [createReviewCapabilityLease, extensions],
  );

  /**
   * Reveal the sidebar area, assigned each render once the responsive layout
   * is known (the controls above are created before it is computed).
   */
  const revealSidebarAreaRef = useRef<() => void>(() => {});

  const {
    accept: acceptExtensionDialog,
    cancel: cancelExtensionDialog,
    createDialogs: createQueuedExtensionDialogs,
    inputValue: extensionDialogInputValue,
    moveSelection: moveExtensionDialogSelection,
    pickOption: setExtensionDialogSelectedIndex,
    request: extensionDialog,
    selectedIndex: extensionDialogSelectedIndex,
    updateInput: setExtensionDialogInputValue,
  } = useExtensionDialogController({ reviewGeneration: bootstrap });

  /** Keep third-party dialog attribution while presenting bundled extensions as native Hunk UI. */
  const createExtensionDialogs = useCallback(
    (extensionId: string) => {
      const lease = createReviewCapabilityLease();
      const bundled = extensions?.registry.extensions.some(
        (metadata) => metadata.id === extensionId && metadata.origin === "bundled",
      );
      return createQueuedExtensionDialogs(extensionId, {
        isLive: lease.isLive,
        showAttribution: !bundled,
      });
    },
    [createQueuedExtensionDialogs, createReviewCapabilityLease, extensions],
  );

  const extensionWorkspaceController = useExtensionWorkspaceControls({
    createExtensionDialogs,
    createReviewCapabilityLease,
    files: reviewFiles,
    input: bootstrap.input,
    onWorkspaceWriteCompleted,
    root: bootstrap.reloadContext.repoRoot ?? bootstrap.reloadContext.cwd,
    runWorkspaceWrite,
    workspaceFileWriter,
  });

  // Lifecycle and bus listeners receive the same pane, navigation, and dialog
  // controls as commands, so onboarding can stay entirely in the public API.
  if (extensions) {
    extensions.eventContextProvider = (extensionId): ExtensionEventContext => {
      const panes = createPaneControls(extensionId);
      return {
        cwd: extensions.context.cwd,
        notify: (message, type) => extensions.context.notify(message, type),
        panes,
        sidebars: panes,
        navigation: createExtensionNavigation(extensionId),
        dialogs: createExtensionDialogs(extensionId),
        events: {
          emit(event, payload) {
            emitExtensionCustomEvent(extensions, event, payload);
          },
        },
      };
    };
  }

  /** Invoke one extension command with its context, containing any failure. */
  const runExtensionCommand = useCallback(
    (registered: RegisteredCommand) => {
      const report = (error: unknown) => {
        extensions?.context.notify(
          `Extension ${registered.extensionId} failed command "${registered.command.id}" • ` +
            `${error instanceof Error ? error.message || error.name : String(error)}`,
          "warning",
        );
      };
      const panes = createPaneControls(registered.extensionId);
      const ctx: ExtensionCommandContext = {
        cwd: extensions?.context.cwd ?? process.cwd(),
        commands: extensionCommandControls,
        keyboardModes: createKeyboardModeControls(registered.extensionId, extensions?.registry),
        notify: (message, type) => extensions?.context.notify(message, type),
        panes,
        sidebars: panes,
        fileViews: createFileViewControls(registered.extensionId),
        highlights: createLineHighlightControls(registered.extensionId),
        // Reads the shared store directly, returning copied immutable state while this
        // command still owns the current review generation.
        review: createExtensionReviewControls(),
        // Snapshot semantics: built when the key fires, so the handler sees
        // where the review was at that moment, even if it awaits and the user
        // navigates on.
        selection: getExtensionSelection(),
        // Bound to the requesting extension for attribution, and valid for the
        // whole life of the handler's promise — a handler may ask several
        // questions in sequence with work between them.
        dialogs: createExtensionDialogs(registered.extensionId),
        // Bound to the requesting extension the same way, because a write is a
        // question first: the confirm it raises names this extension, and the
        // review it may reload is read live rather than captured here.
        workspace: extensionWorkspaceController.createWorkspaceControls(registered.extensionId),
        // Live, unlike `selection`: reads the visible files and delegates to
        // the same focus/jump callbacks a sidebar row click runs, so a handler
        // that awaits a dialog before navigating still acts on the current
        // review — validated, clamped, and warned exactly like sidebar actions.
        navigation: createExtensionNavigation(registered.extensionId),
      };

      try {
        const returned = registered.handler(ctx);
        if (returned && typeof (returned as PromiseLike<void>).then === "function") {
          Promise.resolve(returned).catch(report);
        }
      } catch (error) {
        report(error);
      }
    },
    // `getExtensionSelection` is identity-stable (it reads refs), so the
    // dispatch table, keymap, and Extensions menu derived from this callback
    // do not rebuild on every `[`/`]` press.
    [
      createExtensionDialogs,
      createExtensionNavigation,
      createExtensionReviewControls,
      createFileViewControls,
      createKeyboardModeControls,
      createLineHighlightControls,
      createPaneControls,
      extensionCommandControls,
      extensionWorkspaceController.createWorkspaceControls,
      extensions,
      getExtensionSelection,
    ],
  );

  const registeredExtensionCommands = useMemo(
    () => (extensions ? resolveExtensionCommands(extensions.registry).commands : []),
    [extensions],
  );
  // The session keymap: every bindable command's defaults folded against the
  // user's `[keybindings]` table, once. Matchers, key labels, and extension
  // conflict detection all read this one answer, so nothing downstream has to
  // know whether a key came from a default or from config.
  const keymap = useMemo(
    () =>
      resolveCommandKeys({
        defaults: [
          ...builtinCommandKeyDefaults(),
          ...extensionCommandKeyDefaults(registeredExtensionCommands),
        ],
        userBindings: bootstrap.keybindings,
      }),
    [bootstrap.keybindings, registeredExtensionCommands],
  );
  const resolvedCommandKeys = keymap.keys;
  const extensionAppCommands = useMemo(
    () =>
      buildExtensionAppCommands({
        registered: registeredExtensionCommands,
        builtins: builtinCommandMatchProbes(resolvedCommandKeys),
        resolvedKeys: resolvedCommandKeys,
        runCommand: runExtensionCommand,
      }),
    [registeredExtensionCommands, resolvedCommandKeys, runExtensionCommand],
  );
  // Pane views receive the dispatcher’s effective keys, including command
  // conflicts, rather than independently resolving their default bindings.
  const paneKeybindings = useMemo(() => {
    const effectiveKeys = new Map(resolvedCommandKeys);
    for (const command of extensionAppCommands.commands) {
      effectiveKeys.set(command.id, command.keys);
    }
    return createExtensionPaneKeybindings(effectiveKeys);
  }, [extensionAppCommands.commands, resolvedCommandKeys]);
  const reportedCommandConflictsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const conflict of extensionAppCommands.conflicts) {
      // One command can lose one chord and keep another, so a conflict is
      // reported per refused chord rather than per command.
      const reportKey = `${conflict.fullId}:${conflict.key}`;
      if (reportedCommandConflictsRef.current.has(reportKey)) {
        continue;
      }

      reportedCommandConflictsRef.current.add(reportKey);
      extensions?.context.notify(
        `Extension ${conflict.extensionId} key "${conflict.key}" is taken by ${conflict.conflictingId} • ` +
          `command "${conflict.fullId}" left unbound`,
        "warning",
      );
    }
  }, [extensionAppCommands, extensions]);

  const reportedKeymapIssuesRef = useRef(new Set<string>());
  useEffect(() => {
    // A bad `[keybindings]` entry is a typo in the user's own config, not a
    // reason to refuse the session: the rest of the keymap still applies and
    // the problem is reported on the notice row. The notice row shows one
    // message at a time, so a burst is summarized rather than overwritten.
    const unreported = keymap.issues.filter(
      (issue) => !reportedKeymapIssuesRef.current.has(issue.message),
    );
    const first = unreported[0];
    if (!first) {
      return;
    }

    for (const issue of unreported) {
      reportedKeymapIssuesRef.current.add(issue.message);
    }

    const remaining = unreported.length - 1;
    showSessionNotice(
      sanitizeTerminalLine(
        remaining > 0
          ? `${first.message} (+${remaining} more keybinding issue${remaining === 1 ? "" : "s"})`
          : first.message,
      ),
    );
  }, [keymap, showSessionNotice]);

  // The initial selected file is a view too, so extensions can populate a
  // file-scoped pane without waiting for the user to navigate first. Track the
  // file object, not only its id: a soft reload replaces its contents while
  // preserving stable navigation ids.
  const lastViewedFileRef = useRef<typeof selectedFile>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const hunkIndex = selectedFileId === null ? null : selectedHunkIndex;
      emitExtensionEvent(extensions, "selection_changed", { fileId: selectedFileId, hunkIndex });
      if (selectedFile && selectedFile !== lastViewedFileRef.current) {
        lastViewedFileRef.current = selectedFile;
        emitExtensionEvent(extensions, "file_viewed", { file: selectedFile, hunkIndex });
      }
    }, SELECTION_CHANGED_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [extensions, selectedFile, selectedFileId, selectedHunkIndex]);

  const reportedFilterRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (reportedFilterRef.current !== undefined && reportedFilterRef.current !== review.filter) {
      emitExtensionEvent(extensions, "filter_changed", { filter: review.filter });
    }
    reportedFilterRef.current = review.filter;
  }, [extensions, review.filter]);

  const bodyPadding = pagerMode ? 0 : BODY_PADDING;
  const bodyWidth = Math.max(0, terminal.width - bodyPadding);
  const responsiveLayout = resolveResponsiveLayout(layoutMode, terminal.width);
  const canForceShowSidebar =
    bodyWidth >= SIDEBAR_MIN_WIDTH + EXTENSION_PANE_DIVIDER_SIZE + DIFF_MIN_WIDTH;
  const sidebarAreaVisible =
    sidebarVisible && (responsiveLayout.showSidebar || (forceSidebarOpen && canForceShowSidebar));
  const resolvedLayout = responsiveLayout.layout;
  const reportedLayoutRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const signature = `${layoutMode}:${resolvedLayout}`;
    if (reportedLayoutRef.current !== undefined && reportedLayoutRef.current !== signature) {
      emitExtensionEvent(extensions, "layout_changed", {
        mode: layoutMode,
        layout: resolvedLayout,
      });
    }
    reportedLayoutRef.current = signature;
  }, [extensions, layoutMode, resolvedLayout]);
  const statusBarVisible =
    focusArea === "filter" ||
    Boolean(review.filter) ||
    Boolean(
      sessionNoticeText ??
      transientNoticeText ??
      noticeText ??
      fileViewModeHint ??
      keyboardModeHint,
    );
  const bodyHeight = Math.max(
    0,
    terminal.height - (showMenuBar ? 1 : 0) - (extensionToast ? 1 : 0) - (statusBarVisible ? 1 : 0),
  );
  const failedFilesReplacement = sessionPanes.some(
    (pane) =>
      paneOpenState.open.includes(pane.key) &&
      pane.registered.pane.replaces === HUNK_FILES_PANE_KEY &&
      paneAvailabilityQuarantineRef.current.has(pane.registered),
  );
  const effectiveOpenPaneKeys = paneOpenState.open.filter((key) => {
    const pane = sessionPanes.find((entry) => entry.key === key);
    return sidebarAreaVisible || (pane?.placement !== "left" && pane?.placement !== "right");
  });
  if (
    failedFilesReplacement &&
    sidebarAreaVisible &&
    !effectiveOpenPaneKeys.includes(HUNK_FILES_PANE_KEY)
  ) {
    effectiveOpenPaneKeys.push(HUNK_FILES_PANE_KEY);
  }
  const paneLayout = useMemo(
    () =>
      planExtensionPanes({
        panes: sessionPanes,
        openKeys: effectiveOpenPaneKeys,
        sizes: paneSizes,
        bodyWidth,
        bodyHeight,
        minReviewWidth: DIFF_MIN_WIDTH,
        minReviewHeight: MIN_EXTENSION_REVIEW_HEIGHT,
        currentLine: currentLinePaint,
        retainCurrentLineKeys: currentLinePaintPending
          ? retainedCurrentLinePaneKeysRef.current
          : undefined,
        availabilityContext: {
          files: getExtensionFileViews(),
          selectedFileId,
          selectedHunkIndex,
        },
        quarantined: paneAvailabilityQuarantineRef.current,
        onAvailabilityError: (pane, error) =>
          extensions?.context.notify(
            `Extension ${pane.registered.extensionId} pane "${pane.registered.pane.id}" availability failed • ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          ),
      }),
    [
      bodyHeight,
      bodyWidth,
      currentLinePaint,
      currentLinePaintPending,
      effectiveOpenPaneKeys.join("\0"),
      extensions,
      filteredFiles,
      getExtensionFileViews,
      paneFailureEpoch,
      paneSizes,
      selectedFileId,
      selectedHunkIndex,
      sessionPanes,
    ],
  );
  useLayoutEffect(() => {
    if (currentLinePaintPending) return;
    retainedCurrentLinePaneKeysRef.current = new Set(
      paneLayout.panes
        .filter(({ pane }) => pane.registered.pane.currentLine === true)
        .map(({ pane }) => pane.key),
    );
  }, [currentLinePaintPending, paneLayout]);
  const renderSidebar = paneLayout.panes.some(
    ({ pane }) => pane.placement === "left" || pane.placement === "right",
  );
  const visiblePaneKeys = paneLayout.panes.map(({ pane }) => pane.key);
  const visibleFilesPaneKey = resolvePaneSlotKey({
    panes: sessionPanes,
    slotKey: HUNK_FILES_PANE_KEY,
    openKeys: visiblePaneKeys,
    quarantined: paneAvailabilityQuarantineRef.current,
  });
  const filesPaneVisible = visiblePaneKeys.includes(visibleFilesPaneKey);
  const diffPaneWidth = paneLayout.reviewBounds.width;
  const diffPaneHeight = paneLayout.reviewBounds.height;
  const diffContentWidth = Math.max(0, diffPaneWidth - 2);
  // Mirrors toggleFilesPane's reveal half: visible again, forced open when the
  // responsive layout alone would keep it hidden and the terminal has room.
  revealSidebarAreaRef.current = () => {
    setSidebarVisible(true);
    if (!responsiveLayout.showSidebar && canForceShowSidebar) {
      setForceSidebarOpen(true);
    }
  };
  // Publish the live note geometry for daemon-driven markup validation; the
  // note markup width mirrors what AgentInlineNote lays STML out at.
  noteGeometryRef.current = { layout: resolvedLayout, width: diffContentWidth };
  const noteMarkupWidth = agentNoteMarkupWidth({
    anchorSide: "new",
    layout: resolvedLayout,
    width: diffContentWidth,
  });
  const showFileViewWarning = useCallback(
    (message: string) => extensions?.context.notify(message, "warning"),
    [extensions],
  );
  const { layouts: fileViewLayouts, reportRowFailure: reportFileViewRowFailure } =
    useFilePresentationRendering({
      files: filteredFiles,
      selections: availableFileViewSelectionState,
      epochs: fileViewEpochs,
      views: sessionFileViews,
      width: diffContentWidth,
      onIssue: showSessionNotice,
      onWarning: showFileViewWarning,
    });

  const extensionLineHighlights = useLineHighlights({
    files: filteredFiles,
    highlighters: sessionLineHighlighters,
    epochs: lineHighlightEpochs,
    onIssue: showFileViewWarning,
  });

  // Extension marks and agent attention marks paint through one pipeline: the
  // merged map is the only mark source the diff pane sees.
  const paintedLineHighlights = useMemo(
    () => mergeLineHighlightMaps(extensionLineHighlights, review.agentLineHighlightsByFileId),
    [extensionLineHighlights, review.agentLineHighlightsByFileId],
  );

  useHunkSessionBridge({
    addAgentLineHighlight: review.addAgentLineHighlight,
    addLiveComment: review.addLiveComment,
    addLiveCommentBatch: review.addLiveCommentBatch,
    clearAgentLineHighlights: review.clearAgentLineHighlights,
    clearLiveComments: review.clearLiveComments,
    hostClient,
    liveCommentCount: review.liveCommentCount,
    liveCommentSummaries: review.liveCommentSummaries,
    navigateToLocation: review.navigateToLocation,
    noteMarkupWidth: stmlEnabled ? noteMarkupWidth : undefined,
    openAgentNotes,
    reloadSession: onReloadSession,
    removeLiveComment: review.removeLiveComment,
    reviewProducer,
    reviewNoteCount: review.reviewNoteCount,
    reviewNoteSummaries: review.reviewNoteSummaries,
    reviewStateRevision: review.stateRevision,
    selectedFile,
    selectedHunk: review.selectedHunk,
    selectedHunkIndex,
    showAgentNotes,
  });
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
  const isResizingPane = paneResize !== null;

  useEffect(() => {
    if (
      paneResize &&
      !paneLayout.panes.some(
        (planned) =>
          planned.pane.key === paneResize.key &&
          planned.pane.registered === paneResize.registered &&
          planned.pane.placement === paneResize.placement &&
          planned.divider !== undefined,
      )
    ) {
      setPaneResize(null);
    }
  }, [paneLayout.panes, paneResize]);

  useEffect(() => {
    // Force an intermediate redraw when app geometry or row-wrapping changes so pane relayout
    // feels immediate after toggling split/stack or line wrapping.
    renderer.intermediateRender();
  }, [renderer, renderSidebar, resolvedLayout, terminal.height, terminal.width, wrapLines]);

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

  /** Ask DiffPane to align the current rendered line using its authoritative row geometry. */
  const alignCurrentLine = useCallback((alignment: CurrentLineAlignment) => {
    setLineCursorAlignmentRequest((current) => ({
      id: current.id + 1,
      alignment,
    }));
  }, []);

  /** Step one line: move the current line, or scroll the viewport when there is no marker. */
  const stepDiffLine = (delta: number) => {
    if (!activeLineCursor) {
      scrollDiff(delta, "step");
      return;
    }

    review.moveLineCursor(delta);
  };

  const maxCodeHorizontalOffset = useMemo(() => {
    // Wrapped rows never consume the horizontal offset. Avoid scanning every code line—especially
    // long Unicode lines—until nowrap mode actually needs a global horizontal extent.
    if (wrapLines) {
      return 0;
    }

    return Math.max(
      0,
      filteredFiles.reduce(
        (maxWidth, file) => Math.max(maxWidth, maxFileCodeLineWidth(file, tabWidth)),
        0,
      ) - codeViewportWidth,
    );
  }, [codeViewportWidth, filteredFiles, tabWidth, wrapLines]);

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
    review.toggleAgentNotes();
  };

  /** Toggle line-number gutters without changing the diff content itself. */
  const toggleLineNumbers = () => {
    setShowLineNumbers((current) => !current);
  };

  /** Toggle whether mouse selection copies review decorations or only file content. */
  const toggleCopyDecorations = () => {
    setCopyDecorations((current) => !current);
  };

  /** Toggle whether diff code rows wrap instead of truncating to one terminal row. */
  const toggleLineWrap = () => {
    // Capture the pre-toggle viewport position synchronously so DiffPane can restore the same
    // top-most source row after wrapped row heights change.
    wrapToggleScrollTopRef.current = diffScrollRef.current?.scrollTop ?? 0;
    setCodeHorizontalOffset(0);
    setWrapLines((current) => !current);
  };

  const reportedThemeIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (reportedThemeIdRef.current !== undefined && reportedThemeIdRef.current !== themeId) {
      emitExtensionEvent(extensions, "theme_changed", { themeId });
    }
    reportedThemeIdRef.current = themeId;
  }, [extensions, themeId]);

  /** Toggle only the active files pane without changing extension pane visibility. */
  const toggleFilesPane = () => {
    const filesPaneKey = resolvePaneSlotKey({
      panes: sessionPanes,
      slotKey: HUNK_FILES_PANE_KEY,
      openKeys: paneOpenStateRef.current.open,
      quarantined: paneAvailabilityQuarantineRef.current,
    });

    const filesPane = sessionPanes.find((pane) => pane.key === filesPaneKey);
    const usesSidebarArea = filesPane?.placement === "left" || filesPane?.placement === "right";
    if (usesSidebarArea && !sidebarAreaVisible) {
      setPaneOpen(filesPaneKey, true);
      revealSidebarAreaRef.current();
      return;
    }

    setPaneOpen(filesPaneKey, "toggle");
  };

  /** Toggle visibility of hunk metadata rows without changing the actual diff lines. */
  const toggleHunkHeaders = () => {
    setShowHunkHeaders((current) => !current);
  };

  /** Toggle the top menu bar while keeping F10 menu navigation available. */
  const toggleMenuBar = () => {
    setShowMenuBar((current) => !current);
  };

  const { canRefreshCurrentInput, refreshCurrentInput, triggerRefreshCurrentInput } =
    useCurrentReviewRefreshController({
      input: bootstrap.input,
      onRegisterWorkspaceRefreshRequest,
      onReloadSession,
      onWatchReloadPending: () => emitExtensionEvent(extensions, "watch_reload_pending", {}),
      reloadContext: bootstrap.reloadContext,
      sourceLabel: bootstrap.changeset.sourceLabel,
      view: {
        layoutMode,
        themeId,
        showAgentNotes,
        showHunkHeaders,
        showLineNumbers,
        showMenuBar,
        wrapLines,
      },
      watchRuntime,
    });

  /**
   * Open the trust prompt whenever a repo root needs an answer it has not been asked for.
   *
   * Each root is marked as offered before the prompt opens, so dismissing with
   * "not now" is not immediately re-prompted by this effect; only a genuinely
   * different pending root asks again. When the pending root clears — the usual
   * case being a trust grant followed by a reload — the prompt closes itself.
   */
  useEffect(() => {
    const nextRoot = nextExtensionTrustPromptRoot({
      enabled: !pagerMode,
      pendingRepoRoot: pendingTrustRepoRoot,
      offeredRepoRoots: offeredTrustRepoRootsRef.current,
    });

    if (nextRoot) {
      offeredTrustRepoRootsRef.current.add(nextRoot);
      setExtensionTrustPromptRoot(nextRoot);
      return;
    }

    if (!pendingTrustRepoRoot) {
      setExtensionTrustPromptRoot(null);
    }
  }, [pagerMode, pendingTrustRepoRoot]);

  /** Dismiss the repo-extension trust prompt without recording a decision. */
  const closeExtensionTrustPrompt = useCallback(() => {
    setExtensionTrustPromptRoot(null);
  }, []);

  /**
   * Record this repo as trusted, then reload so its extensions actually load.
   *
   * The reload goes through the normal session-reload path with extension
   * loading re-run, which is what makes a freshly trusted transform or theme
   * apply without restarting Hunk.
   */
  const trustRepoExtensions = useCallback(() => {
    const repoRoot = extensionTrustPromptRoot;
    setExtensionTrustPromptRoot(null);
    if (!repoRoot) {
      return;
    }

    try {
      writeExtensionTrust(repoRoot, "trusted");
    } catch (error) {
      showSessionNotice(
        error instanceof Error ? error.message : "Failed to record the trust decision.",
      );
      return;
    }

    if (!canRefreshCurrentInput) {
      // Stdin-backed reviews cannot be reopened, so trust applies next launch.
      showSessionNotice("Trusted this repository • restart Hunk to load its extensions");
      return;
    }

    void refreshCurrentInput({ reason: "manual", reloadExtensions: true }).catch(() => {
      showSessionNotice("Failed to reload after trusting this repository's extensions.");
    });
  }, [canRefreshCurrentInput, extensionTrustPromptRoot, refreshCurrentInput, showSessionNotice]);

  /** Record this repo as denied so Hunk stops offering to run its extensions. */
  const denyRepoExtensions = useCallback(() => {
    const repoRoot = extensionTrustPromptRoot;
    setExtensionTrustPromptRoot(null);
    if (!repoRoot) {
      return;
    }

    try {
      writeExtensionTrust(repoRoot, "denied");
      showSessionNotice("Won't run this repository's extensions");
    } catch (error) {
      showSessionNotice(
        error instanceof Error ? error.message : "Failed to record the trust decision.",
      );
    }
  }, [extensionTrustPromptRoot, showSessionNotice]);

  const triggerEditSelectedFile = useCallback(() => {
    const basePath = isVcsReviewInput(bootstrap.input)
      ? bootstrap.changeset.sourceLabel
      : undefined;
    const message = openSelectedFileInEditor({
      basePath,
      file: selectedFile,
      lineCursor: activeLineCursor,
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
    activeLineCursor,
    bootstrap.changeset.sourceLabel,
    bootstrap.input.kind,
    canRefreshCurrentInput,
    renderer,
    review.selectedHunk,
    selectedFile,
    showSessionNotice,
    triggerRefreshCurrentInput,
  ]);

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

  // Command-handler navigation lands here each render: the same focus and jump
  // semantics the sidebar's onSelect handlers use, so a command's navigation is
  // indistinguishable from a sidebar row click. Read through a ref because the
  // command dispatch table is built above these helpers and must stay
  // identity-stable while the review moves.
  extensionCommandNavigationRef.current = {
    onSelectFile: (fileId) => {
      focusFiles();
      jumpToFile(fileId, { alignFileHeaderTop: true });
    },
    onSelectHunk: (fileId, hunkIndex) => {
      focusFiles();
      review.selectHunk(fileId, hunkIndex);
    },
    onRevealLine: (fileId, side, line) => {
      focusFiles();
      return review.revealLine(fileId, side, line);
    },
  };

  /** Toggle keyboard focus between the file list and the file filter. */
  const toggleFocusArea = useCallback(() => {
    setFocusArea((current) => (current === "files" ? "filter" : "files"));
  }, []);

  /** Move keyboard ownership into the draft note editor. */
  const focusDraftNoteEditor = useCallback(() => setFocusArea("note"), []);
  /** Return keyboard ownership from note composition to review navigation. */
  const focusReviewAfterDraft = useCallback(() => setFocusArea("files"), []);
  /** Leave note focus only when the draft editor still owns it. */
  const blurDraftNoteEditor = useCallback(
    () => setFocusArea((current) => (current === "note" ? "files" : current)),
    [],
  );
  /** Publish one user-note event through the current extension runtime. */
  const publishUserNoteEvent: UserNoteEventPublisher = useCallback(
    (event, payload) => emitExtensionEvent(extensions, event, payload),
    [extensions],
  );
  const {
    blurDraftNote,
    cancelDraftNote,
    focusDraftNote,
    onActiveAddNoteAffordanceChange,
    saveDraftNote,
    startUserNote,
    updateDraftNote,
  } = useUserNoteComposer({
    draftNote: review.draftNote,
    keyboardCursorEnabled: cursorLine !== "off",
    getLineCursor: review.getLineCursor,
    startDraft: review.startUserNote,
    updateDraft: review.updateDraftNote,
    saveDraft: review.saveDraftNote,
    cancelDraft: review.cancelDraftNote,
    focus: {
      draft: focusDraftNoteEditor,
      review: focusReviewAfterDraft,
      blurDraft: blurDraftNoteEditor,
    },
    publishEvent: publishUserNoteEvent,
  });

  // One dispatch table for every app-level shortcut: the built-in commands
  // over App's live callbacks, then extension commands, so built-ins always
  // win a key and extension order follows load order.
  const appCommands = observeAppCommandDispatch(
    [
      ...buildAppCommands({
        canAlignCurrentLine: cursorLine !== "off" && review.lineCursor !== null,
        canApplyFilePresentationToAllMatching: selectedFileViewBulkTarget !== null,
        canRefreshCurrentInput,
        alignCurrentLine,
        applyFilePresentationToAllMatching,
        focusFilter,
        moveSelection: review.moveSelection,
        openAgentSkill,
        openThemeSelector,
        requestQuit,
        resolvedKeys: resolvedCommandKeys,
        scrollCodeHorizontally,
        scrollDiff,
        stepDiffLine,
        selectCursorLine: setCursorLine,
        selectLayoutMode,
        startUserNote: () => startUserNote(),
        toggleAgentNotes,
        toggleCopyDecorations,
        toggleFocusArea,
        toggleGapForSelectedHunk: review.toggleSelectedHunkGap,
        toggleHelp,
        toggleHunkHeaders,
        toggleLineNumbers,
        toggleLineWrap,
        toggleMenuBar,
        toggleFilesPane,
        triggerEditSelectedFile,
        triggerRefreshCurrentInput,
      }),
      ...extensionAppCommands.commands,
    ],
    (commandId) => emitExtensionEvent(extensions, "command_executed", { commandId }),
  );
  extensionHostCommandsRef.current = appCommands;

  // Menus name commands rather than repeating them: every item's key hint and
  // action come from the table above, so a remapped shortcut shows its new key
  // and a menu item can never drift from the command it claims to run. Built
  // fresh each render — construction is a handful of lookups, and both the
  // hints and the checkbox state have to stay live.
  const menus = buildAppMenus({
    commands: appCommands,
    cursorLine,
    extensionCommands: extensionAppCommands.commands,
    fileViewEntries: selectedFileViewEntries,
    fileViewApplyAllLabel: selectedFileViewBulkTarget
      ? `Apply “${selectedFileViewBulkTarget.title}” to all matching files`
      : undefined,
    keyboardModeExitEntry: keyboardModeTitle
      ? {
          kind: "item",
          label: `Exit ${keyboardModeTitle}`,
          commandId: "hunk.extensions.exitKeyboardMode",
          action: exitKeyboardMode,
        }
      : undefined,
    copyDecorations,
    layoutMode,
    filesPaneVisible,
    showAgentNotes,
    showHelp,
    showHunkHeaders,
    showLineNumbers,
    showMenuBar,
    wrapLines,
  });

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
    closeAgentSkill,
    closeHelp,
    closeMenu,
    acceptThemeSelector,
    cancelDraftNote,
    closeThemeSelector,
    closeExtensionTrustPrompt,
    commands: appCommands,
    denyRepoExtensions,
    extensionDialog,
    acceptExtensionDialog,
    cancelExtensionDialog,
    moveExtensionDialogSelection,
    extensionTrustPromptOpen,
    trustRepoExtensions,
    isFileViewModeActive,
    exitFileViewMode,
    sendFileViewModeKey,
    isKeyboardModeActive,
    exitKeyboardMode,
    sendKeyboardModeKey,
    focusArea,
    moveMenuItem,
    moveThemeSelector,
    openMenu,
    saveConfigPromptOpen,
    saveViewPreferencesAndQuit,
    discardViewPreferencesAndQuit,
    neverAskToSaveViewPreferencesAndQuit,
    closeSaveConfigPrompt,
    saveDraftNote,
    showAgentSkill,
    showHelp,
    switchMenu,
    toggleFocusArea,
    themeSelectorOpen,
  });

  /** Start a mouse drag for one resizable pane. */
  const beginPaneResize = (planned: PlannedPane) => (event: TuiMouseEvent) => {
    if (event.button !== MouseButton.LEFT) return;
    const vertical = planned.pane.placement === "left" || planned.pane.placement === "right";
    const spec = extensionPaneSize(planned.pane.registered.pane, planned.pane.placement);
    const currentSize = vertical ? planned.bounds.width : planned.bounds.height;
    closeMenu();
    setPaneResize({
      key: planned.pane.key,
      registered: planned.pane.registered,
      placement: planned.pane.placement,
      origin: vertical ? event.x : event.y,
      startSize: currentSize,
      maxSize: Math.min(
        spec.max ?? Number.MAX_SAFE_INTEGER,
        currentSize +
          Math.max(
            0,
            vertical
              ? diffPaneWidth - DIFF_MIN_WIDTH
              : diffPaneHeight - MIN_EXTENSION_REVIEW_HEIGHT,
          ),
      ),
      minSize: spec.min ?? 1,
    });
    event.preventDefault();
    event.stopPropagation();
  };

  /** Update the active pane drag on its placement axis. */
  const updatePaneResize = (event: TuiMouseEvent) => {
    if (!paneResize) return;
    const { key, placement, origin, startSize, maxSize, minSize } = paneResize;
    const vertical = placement === "left" || placement === "right";
    const position = vertical ? event.x : event.y;
    const inverted = placement === "right" || placement === "bottom";
    const next = inverted
      ? resizeSidebarWidth(startSize, position, origin, minSize, maxSize)
      : resizeSidebarWidth(startSize, origin, position, minSize, maxSize);
    setPaneSizes((current) => (current[key] === next ? current : { ...current, [key]: next }));
    event.preventDefault();
    event.stopPropagation();
  };

  const endPaneResize = (event?: TuiMouseEvent) => {
    if (!isResizingPane) return;
    setPaneResize(null);
    event?.preventDefault();
    event?.stopPropagation();
  };

  const changedFileCount = bootstrap.changeset.files.length;
  const changedFileLabel = changedFileCount === 1 ? "file" : "files";
  const totalAdditions = bootstrap.changeset.files.reduce(
    (sum, file) => sum + file.stats.additions,
    0,
  );
  const totalDeletions = bootstrap.changeset.files.reduce(
    (sum, file) => sum + file.stats.deletions,
    0,
  );
  const topTitle = `${bootstrap.changeset.title}  ${changedFileCount} ${changedFileLabel}  +${totalAdditions}  -${totalDeletions}`;
  const diffHeaderStatsWidth = maxFileHeaderStatsWidth(filteredFiles);
  const diffHeaderLabelWidth = Math.max(0, diffContentWidth - diffHeaderStatsWidth - 1);
  const diffSeparatorWidth = Math.max(0, diffContentWidth - 2);
  const diffPaneScreenTop = (showMenuBar ? 1 : 0) + paneLayout.reviewBounds.y;

  /** Render one pane from the exact accepted host rectangle. */
  const renderPane = (planned: PlannedPane) => {
    const selection = getExtensionSelection();
    const { bounds, pane } = planned;
    return (
      <box
        key={pane.key}
        style={{
          position: "absolute",
          left: bodyPadding / 2 + bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: bounds.height,
        }}
      >
        <ExtensionPaneHost
          registered={pane.registered}
          files={filteredFiles}
          fileViews={getExtensionFileViews()}
          selectedFileId={selection.file?.id ?? null}
          selectedHunkIndex={selection.hunkIndex}
          placement={pane.placement}
          theme={activeTheme}
          width={bounds.width}
          height={bounds.height}
          currentLine={pane.registered.pane.currentLine ? currentLinePaint : null}
          showTopChrome={showMenuBar}
          keybindings={paneKeybindings}
          notify={(message, type) => extensions?.context.notify(message, type)}
          onSelectFile={(fileId) => {
            focusFiles();
            jumpToFile(fileId, { alignFileHeaderTop: true });
          }}
          onSelectHunk={(fileId, hunkIndex) => {
            focusFiles();
            review.selectHunk(fileId, hunkIndex);
          }}
          onRevealLine={(fileId, side, line) => {
            focusFiles();
            return review.revealLine(fileId, side, line);
          }}
          onRenderFailure={
            pane.key === HUNK_FILES_PANE_KEY
              ? undefined
              : () => {
                  paneAvailabilityQuarantineRef.current.add(pane.registered);
                  if (pane.registered.pane.replaces === HUNK_FILES_PANE_KEY) {
                    setPaneOpen(pane.key, false);
                    setPaneOpen(HUNK_FILES_PANE_KEY, true);
                    revealSidebarAreaRef.current();
                  }
                  setPaneFailureEpoch((value) => value + 1);
                }
          }
        />
      </box>
    );
  };

  const renderDivider = (planned: PlannedPane) =>
    planned.divider ? (
      <box
        key={`${planned.pane.key}:divider`}
        style={{
          position: "absolute",
          left: bodyPadding / 2 + planned.divider.x,
          top: planned.divider.y,
          width: planned.divider.width,
          height: planned.divider.height,
        }}
      >
        <PaneDivider
          orientation={planned.divider.width === 1 ? "vertical" : "horizontal"}
          width={planned.divider.width}
          height={planned.divider.height}
          isResizing={paneResize?.key === planned.pane.key}
          theme={activeTheme}
          onMouseDown={beginPaneResize(planned)}
          onMouseDrag={updatePaneResize}
          onMouseDragEnd={endPaneResize}
          onMouseUp={endPaneResize}
        />
      </box>
    ) : null;

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: activeTheme.background,
      }}
    >
      {showMenuBar ? (
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
          width: bodyWidth,
          height: bodyHeight,
          flexShrink: 0,
          paddingLeft: bodyPadding / 2,
          paddingRight: bodyPadding / 2,
          position: "relative",
        }}
        onMouseDrag={updatePaneResize}
        onMouseDragEnd={(event) => {
          endPaneResize(event);
          cancelCopySelectionRef.current?.();
        }}
        onMouseUp={(event) => {
          endPaneResize(event);
          closeMenu();
          cancelCopySelectionRef.current?.();
        }}
      >
        {paneLayout.panes.map(renderPane)}
        {paneLayout.panes.map(renderDivider)}
        <box
          style={{
            position: "absolute",
            left: bodyPadding / 2 + paneLayout.reviewBounds.x,
            top: paneLayout.reviewBounds.y,
            width: diffPaneWidth,
            height: diffPaneHeight,
          }}
        >
          <DiffPane
            cancelCopySelectionRef={cancelCopySelectionRef}
            codeHorizontalOffset={codeHorizontalOffset}
            copyDecorations={copyDecorations}
            diffContentWidth={diffContentWidth}
            expandedGapsByFileId={review.expandedGapsByFileId}
            fileViews={fileViewLayouts}
            files={filteredFiles}
            offloadLargeDiff={bootstrap.input.options.fast === true}
            lineHighlights={paintedLineHighlights}
            pagerMode={pagerMode}
            screenTop={diffPaneScreenTop}
            showTopChrome={showMenuBar}
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
            tabWidth={tabWidth}
            wrapLines={wrapLines}
            wrapToggleScrollTop={wrapToggleScrollTopRef.current}
            layoutToggleScrollTop={layoutToggleScrollTopRef.current}
            layoutToggleRequestId={layoutToggleRequestId}
            selectedFileTopAlignRequestId={review.selectedFileTopAlignRequestId}
            selectedHunkRevealRequestId={review.selectedHunkRevealRequestId}
            cursorLine={cursorLine}
            lineCursor={review.lineCursor}
            lineCursorRevealRequest={review.lineCursorRevealRequest}
            lineCursorAlignmentRequest={lineCursorAlignmentRequest}
            theme={activeTheme}
            width={diffPaneWidth}
            height={diffPaneHeight}
            onActiveAddNoteAffordanceChange={onActiveAddNoteAffordanceChange}
            onRemoveUserNote={review.removeUserNote}
            onSaveDraftNote={saveDraftNote}
            onStartUserNoteAtHunk={startUserNote}
            onUpdateDraftNote={updateDraftNote}
            onBlurDraftNote={blurDraftNote}
            onCancelDraftNote={cancelDraftNote}
            onFocusDraftNote={focusDraftNote}
            onScrollCodeHorizontally={(delta) => {
              scrollCodeHorizontally(delta * FAST_CODE_HORIZONTAL_SCROLL_COLUMNS);
            }}
            onCopyFeedback={showTransientNotice}
            onFileViewRowFailure={reportFileViewRowFailure}
            onSelectFile={jumpToFile}
            onToggleGap={review.toggleGap}
            onViewportCenteredHunkChange={(fileId, hunkIndex) =>
              review.anchorSelection(fileId, hunkIndex)
            }
            onLineCursorsChange={setLineCursors}
            currentLinePaintRequested={currentLinePaintRequested}
            onCurrentLinePaintChange={onCurrentLinePaintChange}
            onViewportLineCursorChange={review.anchorLineCursor}
          />
        </box>
      </box>

      {extensionToast ? (
        <ExtensionToast
          notification={extensionToast}
          terminalWidth={terminal.width}
          theme={activeTheme}
        />
      ) : null}

      {statusBarVisible ? (
        <StatusBar
          filter={review.filter}
          filterFocused={focusArea === "filter"}
          modeText={keyboardModeHint ?? undefined}
          noticeText={
            sessionNoticeText ?? transientNoticeText ?? noticeText ?? fileViewModeHint ?? undefined
          }
          terminalWidth={terminal.width}
          theme={activeTheme}
          onCloseMenu={closeMenu}
          onFilterInput={review.setFilter}
          onFilterSubmit={focusFiles}
          onExitMode={exitKeyboardMode}
        />
      ) : null}

      {activeMenuId && activeMenuSpec ? (
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

      {showAgentSkill ? (
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

      {showHelp ? (
        <Suspense fallback={null}>
          <LazyHelpDialog
            commands={appCommands}
            terminalHeight={terminal.height}
            terminalWidth={terminal.width}
            theme={baseTheme}
            onClose={closeHelp}
          />
        </Suspense>
      ) : null}

      {extensionDialog ? (
        <ExtensionDialog
          inputValue={extensionDialogInputValue}
          request={extensionDialog}
          selectedIndex={extensionDialogSelectedIndex}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={baseTheme}
          onAccept={acceptExtensionDialog}
          onCancel={cancelExtensionDialog}
          onChangeInput={setExtensionDialogInputValue}
          onPickOption={setExtensionDialogSelectedIndex}
        />
      ) : null}

      {saveConfigPromptOpen ? (
        <ConfirmDialog
          actions={[
            { keyLabel: "enter/s", label: "save", run: saveViewPreferencesAndQuit },
            { keyLabel: "q", label: "discard", run: discardViewPreferencesAndQuit },
            { keyLabel: "n", label: "never ask", run: neverAskToSaveViewPreferencesAndQuit },
            { keyLabel: "esc", label: "cancel", run: closeSaveConfigPrompt },
          ]}
          height={confirmDialogHeight(4 + viewPreferenceDiffLines.length)}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={baseTheme}
          title="Save view preferences?"
          width={68}
          onClose={closeSaveConfigPrompt}
        >
          <box style={{ width: "100%", height: 1 }}>
            <text fg={baseTheme.muted}>
              You changed {changedViewPreferences.length} view{" "}
              {changedViewPreferences.length === 1 ? "setting" : "settings"} during this review.
            </text>
          </box>
          <box style={{ width: "100%", height: 1 }}>
            <text fg={baseTheme.muted}>
              Save {changedViewPreferences.length === 1 ? "it" : "them"} to your config before
              quitting?
            </text>
          </box>
          <box style={{ width: "100%", height: 1 }} />
          <box style={{ width: "100%", height: 1 }}>
            <text fg={baseTheme.badgeNeutral}>{viewPreferencesConfigLabel}</text>
          </box>
          {viewPreferenceDiffLines.map((line) => (
            <box key={line.text} style={{ width: "100%", height: 1 }}>
              <text fg={line.removed ? baseTheme.badgeRemoved : baseTheme.badgeAdded}>
                {line.text}
              </text>
            </box>
          ))}
        </ConfirmDialog>
      ) : null}

      {!pagerMode && extensionTrustPromptRoot ? (
        <ConfirmDialog
          actions={[
            { keyLabel: "enter/t", label: "trust", run: trustRepoExtensions },
            { keyLabel: "esc", label: "not now", run: closeExtensionTrustPrompt },
            { keyLabel: "n", label: "never", run: denyRepoExtensions },
          ]}
          height={confirmDialogHeight(5)}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={baseTheme}
          title="Run this repository's extensions?"
          width={72}
          onClose={closeExtensionTrustPrompt}
        >
          <box style={{ width: "100%", height: 1 }}>
            <text fg={baseTheme.muted}>
              This repository contains extensions in .hunk/extensions.
            </text>
          </box>
          <box style={{ width: "100%", height: 1 }}>
            <text fg={baseTheme.muted}>Extensions run with your user permissions.</text>
          </box>
          <box style={{ width: "100%", height: 1 }} />
          <box style={{ width: "100%", height: 1 }}>
            <text fg={baseTheme.badgeNeutral}>{extensionTrustPromptRoot}</text>
          </box>
          <box style={{ width: "100%", height: 1 }}>
            <text fg={baseTheme.muted}>
              Trust runs them now and remembers this repo; never won't ask again.
            </text>
          </box>
        </ConfirmDialog>
      ) : null}

      {themeSelectorOpen ? (
        <Suspense fallback={null}>
          <LazyThemeSelectorDialog
            items={themeSelectorItems}
            selectedIndex={themeSelectorSelectedIndex}
            terminalHeight={terminal.height}
            terminalWidth={terminal.width}
            theme={baseTheme}
            onAcceptItem={acceptThemeSelectorItem}
            onClose={closeThemeSelector}
            onPreviewItem={previewThemeSelectorItem}
          />
        </Suspense>
      ) : null}
    </box>
  );
}

import type {
  BoxRenderable,
  MouseEvent as TuiMouseEvent,
  ScrollBoxRenderable,
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
import type { ExtensionReviewReloadResult } from "../extension-api/types";
import { experimentalFeatureEnabled, resolveExperimentalDiffFiles } from "../core/run/experimental";
import { DEFAULT_FILE_GAP, DEFAULT_HUNK_GAP } from "../core/run/reviewGap";
import { DEFAULT_TAB_WIDTH } from "../core/run/tabWidth";
import { isVcsReviewInput } from "../core/vcs";
import type { AppBootstrap } from "../core/bootstrap";
import {
  selectActiveEditableReviewNoteId,
  selectActiveReplyableReviewNoteId,
} from "../core/review/selectors";
import type { CliInput, CursorLine, LayoutMode } from "../core/run/commandInputs";
import { sanitizeTerminalLine } from "../lib/terminalText";
import {
  resolveExtensionCommands,
  resolveExtensionFileViews,
  resolveExtensionKeyboardModes,
  resolveExtensionLineHighlighters,
  resolveExtensionSessionOptions,
} from "../extensions/apply";
import { projectExtensionReviewNotes } from "../extensions/reviewSnapshot";
import type { ExtensionNotifyType, ExtensionLoadResult } from "../extensions/types";
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
import { useExtensionCommandRunner } from "./hooks/useExtensionCommandRunner";
import { useExtensionDialogController } from "./hooks/useExtensionDialogController";
import { useExtensionEventContextProvider } from "./hooks/useExtensionEventContextProvider";
import { useExtensionNotifications } from "./hooks/useExtensionNotifications";
import { useExtensionPaneController } from "./hooks/useExtensionPaneController";
import { useExtensionReviewEvents } from "./hooks/useExtensionReviewEvents";
import {
  useExtensionRuntimeBindings,
  useExtensionRuntimeBridge,
} from "./hooks/useExtensionRuntimeBridge";
import { useExtensionTrustController } from "./hooks/useExtensionTrustController";
import {
  useExtensionWorkspaceControls,
  type WorkspaceFileWriter,
  type WorkspaceWriteRunner,
} from "./hooks/useExtensionWorkspaceControls";
import { useHunkSessionBridge } from "./hooks/useHunkSessionBridge";
import { useMenuController } from "./hooks/useMenuController";
import { useThemeSelectorController } from "./hooks/useThemeSelectorController";
import { useTimedNotice } from "./hooks/useTimedNotice";
import { useUserNoteComposer } from "./hooks/useUserNoteComposer";
import { useTerminalReview, type AgentNoteGeometrySnapshot } from "./hooks/useTerminalReview";
import { useViewPreferenceQuitController } from "./hooks/useViewPreferenceQuitController";
import type { WatchedInputRuntime } from "./hooks/useWatchedInput";
import { agentNoteMarkupWidth } from "./lib/agentNoteGeometry";
import {
  buildAppCommands,
  builtinCommandKeyDefaults,
  builtinCommandMatchProbes,
  observeAppCommandDispatch,
} from "./lib/appCommands";
import { buildAppMenus } from "./lib/appMenus";
import { buildExtensionAppCommands, extensionCommandKeyDefaults } from "./lib/extensionCommands";
import { createExtensionReviewReloadControls } from "./lib/extensionReviewReload";
import type { CurrentLineAlignment } from "./lib/hunkScroll";
import type { LineCursor } from "./lib/lineCursors";
import { useFilePresentationController } from "./fileViews/useFilePresentationController";
import { useFilePresentationRendering } from "./fileViews/useFilePresentationRendering";
import { mergeLineHighlightMaps } from "./highlights/merge";
import { useLineHighlights } from "./highlights/useLineHighlights";
import { useLineHighlightsController } from "./highlights/useLineHighlightsController";
import { useKeyboardModeController } from "./keyboardModes/useKeyboardModeController";
import { createExtensionPaneKeybindings, resolveCommandKeys } from "./lib/keymap";
import {
  EXTENSION_PANE_DIVIDER_SIZE,
  MIN_EXTENSION_REVIEW_HEIGHT,
  type PlannedPane,
} from "./lib/extensionPanes";
import { HUNK_FILES_PANE_KEY } from "../extensions/extensionIds";
import { maxFileHeaderStatsWidth } from "./lib/fileHeader";
import { setMouseCapture } from "./lib/mouseCapture";
import { openSelectedFileInEditor } from "./lib/openInEditor";
import { resolveResponsiveLayout } from "./lib/responsive";
import type { WorkspaceRefreshRequest } from "./currentReviewRefresh";

type FocusArea = "files" | "filter" | "note";

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

/** Orchestrate global app state, layout, navigation, and pane coordination. */
export function App({
  bootstrap,
  hostClient,
  noticeText,
  onQuit = () => process.exit(0),
  onRegisterWorkspaceRefreshRequest,
  onReloadSession,
  onRequestExtensionReviewReload,
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
  /** Queue a coalesced reload against the review current when host execution begins. */
  onRequestExtensionReviewReload: (
    reviewGeneration: AppBootstrap,
  ) => Promise<ExtensionReviewReloadResult>;
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
  const fileGap = bootstrap.initialFileGap ?? DEFAULT_FILE_GAP;
  const hunkGap = bootstrap.initialHunkGap ?? DEFAULT_HUNK_GAP;
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
  const paneResizeCaptureRef = useRef<BoxRenderable | null>(null);
  const wrapToggleScrollTopRef = useRef<number | null>(null);
  const layoutToggleScrollTopRef = useRef<number | null>(null);
  const cancelCopySelectionRef = useRef<(() => void) | null>(null);
  const [layoutToggleRequestId, setLayoutToggleRequestId] = useState(0);
  const [scrollEdgeRequest, setScrollEdgeRequest] = useState<{
    id: number;
    edge: "top" | "bottom";
  }>({ id: 0, edge: "top" });
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
  const [showHelp, setShowHelp] = useState(false);
  const [showAgentSkill, setShowAgentSkill] = useState(false);
  const [focusArea, setFocusArea] = useState<FocusArea>("files");
  const { text: sessionNoticeText, show: showSessionNotice } = useTimedNotice(4_000);
  const extensions = bootstrap.extensions as ExtensionLoadResult | undefined;
  const pendingTrustRepoRoot = extensions?.pendingTrustRepoRoot;
  const extensionToast = useExtensionNotifications(extensions?.notifications);

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
  const getActiveExtensionLineCursor = useCallback(
    () => (cursorLine === "off" ? null : review.getLineCursor()),
    [cursorLine, review.getLineCursor],
  );
  const extensionRuntime = useExtensionRuntimeBridge({
    extensions,
    files: filteredFiles,
    getActiveLineCursor: getActiveExtensionLineCursor,
    getSelection: review.getSelection,
    reviewGeneration: bootstrap,
    reviewProducer,
  });
  const {
    commandControls: extensionCommandControls,
    createNavigation: createExtensionNavigation,
    createReviewCapabilityLease,
    createReviewControls: createExtensionReviewControls,
    getCommittedFileViews: getExtensionFileViews,
    getRenderFileViews: getRenderExtensionFileViews,
    getRenderSelection: getRenderExtensionSelection,
    getSelectedFileId,
    getSelection: getExtensionSelection,
  } = extensionRuntime;
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
    promptSaveViewPreferences:
      bootstrap.input.options.promptSaveViewPreferences !== false &&
      process.env.HUNK_RETURN_TO_HISTORY !== "1",
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

  const bodyPadding = pagerMode ? 0 : BODY_PADDING;
  const bodyWidth = Math.max(0, terminal.width - bodyPadding);
  const responsiveLayout = resolveResponsiveLayout(layoutMode, terminal.width);
  const resolvedLayout = responsiveLayout.layout;
  const canForceShowSidebar =
    bodyWidth >= SIDEBAR_MIN_WIDTH + EXTENSION_PANE_DIVIDER_SIZE + DIFF_MIN_WIDTH;
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
  const showPaneWarning = useCallback(
    (message: string) => extensions?.context.notify(message, "warning"),
    [extensions],
  );
  const {
    beginPaneResize,
    createPaneControls,
    currentLinePaint,
    currentLinePaintRequested,
    endPaneResize,
    filesPaneVisible,
    onCurrentLinePaintChange,
    paneLayout,
    reportPaneRenderFailure,
    renderSidebar,
    resizingPaneKey,
    toggleFilesPane,
    updatePaneResize,
  } = useExtensionPaneController({
    availabilityContext: {
      review: bootstrap.review ?? null,
      files: getRenderExtensionFileViews(),
      selectedFileId,
      selectedHunkIndex,
    },
    bodyHeight,
    bodyWidth,
    canForceShowSidebar,
    createReviewCapabilityLease,
    currentLineCursor: review.lineCursor,
    extensions,
    initialSidebar: bootstrap.initialSidebar,
    minReviewHeight: MIN_EXTENSION_REVIEW_HEIGHT,
    minReviewWidth: DIFF_MIN_WIDTH,
    notifyWarning: showPaneWarning,
    pagerMode,
    responsiveShowsSidebar: responsiveLayout.showSidebar,
  });

  useEffect(() => {
    if (resizingPaneKey === null) {
      setMouseCapture(renderer, undefined);
    }
  }, [renderer, resizingPaneKey]);

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

  const createEventReviewReloadControls = useCallback(() => {
    const lease = createReviewCapabilityLease();
    return createExtensionReviewReloadControls({
      isLive: lease.isLive,
      requestReload: () => onRequestExtensionReviewReload(bootstrap),
    });
  }, [bootstrap, createReviewCapabilityLease, onRequestExtensionReviewReload]);

  useExtensionEventContextProvider({
    createDialogs: createExtensionDialogs,
    createNavigation: createExtensionNavigation,
    createPaneControls,
    createReviewReloadControls: createEventReviewReloadControls,
    extensions,
  });

  const runExtensionCommand = useExtensionCommandRunner({
    commandControls: extensionCommandControls,
    createDialogs: createExtensionDialogs,
    createFileViewControls,
    createKeyboardModeControls,
    createLineHighlightControls,
    createNavigation: createExtensionNavigation,
    createPaneControls,
    createReviewControls: createExtensionReviewControls,
    createWorkspaceControls: extensionWorkspaceController.createWorkspaceControls,
    extensions,
    getSelection: getExtensionSelection,
  });

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

  const reviewNotes = useMemo(
    () => projectExtensionReviewNotes(review.store.getSnapshot()),
    [review.stateRevision, review.store],
  );
  const { publishCommandExecuted, publishNoteEvent, publishWatchReloadPending } =
    useExtensionReviewEvents({
      extensions,
      filter: review.filter,
      layoutMode,
      resolvedLayout,
      reviewGeneration: bootstrap.changeset.id,
      reviewNotes,
      selectedFile,
      selectedFileId,
      selectedHunkIndex,
      themeId,
    });
  const diffPaneWidth = paneLayout.reviewBounds.width;
  const diffPaneHeight = paneLayout.reviewBounds.height;
  const diffContentWidth = Math.max(0, diffPaneWidth - 2);
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
    if (unit === "content") {
      if (delta !== 0) {
        setScrollEdgeRequest((current) => ({
          id: current.id + 1,
          edge: delta > 0 ? "bottom" : "top",
        }));
      }
      return;
    }
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
      onWatchReloadPending: publishWatchReloadPending,
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

  const {
    closeExtensionTrustPrompt,
    denyRepoExtensions,
    extensionTrustPromptOpen,
    extensionTrustPromptRoot,
    trustRepoExtensions,
  } = useExtensionTrustController({
    canRefreshCurrentInput,
    pagerMode,
    pendingRepoRoot: pendingTrustRepoRoot,
    refreshCurrentInput,
    showNotice: showSessionNotice,
  });

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

  const extensionNavigationBindings = useMemo(
    () => ({
      onSelectFile: (fileId: string) => {
        focusFiles();
        jumpToFile(fileId, { alignFileHeaderTop: true });
      },
      onSelectHunk: (fileId: string, hunkIndex: number) => {
        focusFiles();
        review.selectHunk(fileId, hunkIndex);
      },
      onRevealLine: (fileId: string, side: "old" | "new", line: number) => {
        focusFiles();
        return review.revealLine(fileId, side, line);
      },
    }),
    [focusFiles, jumpToFile, review.revealLine, review.selectHunk],
  );

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
  const {
    blurDraftNote,
    cancelDraftNote,
    focusDraftNote,
    onActiveAddNoteAffordanceChange,
    saveDraftNote,
    startUserNote,
    startUserNoteEdit,
    startUserNoteReply,
    updateDraftNote,
  } = useUserNoteComposer({
    draftNote: review.draftNote,
    keyboardCursorEnabled: cursorLine !== "off",
    getLineCursor: review.getLineCursor,
    startDraft: review.startUserNote,
    startEdit: review.startUserNoteEdit,
    startReply: review.startUserNoteReply,
    updateDraft: review.updateDraftNote,
    saveDraft: review.saveDraftNote,
    cancelDraft: review.cancelDraftNote,
    focus: {
      draft: focusDraftNoteEditor,
      review: focusReviewAfterDraft,
      blurDraft: blurDraftNoteEditor,
    },
    publishEvent: publishNoteEvent,
  });

  const activeEditableNoteId = selectActiveEditableReviewNoteId(review.store.getSnapshot());
  const activeReplyableNoteId = selectActiveReplyableReviewNoteId(review.store.getSnapshot());

  // One dispatch table for every app-level shortcut: the built-in commands
  // over App's live callbacks, then extension commands, so built-ins always
  // win a key and extension order follows load order.
  const appCommands = observeAppCommandDispatch(
    [
      ...buildAppCommands({
        canAlignCurrentLine: cursorLine !== "off" && review.lineCursor !== null,
        canApplyFilePresentationToAllMatching: selectedFileViewBulkTarget !== null,
        canEditActiveNote: activeEditableNoteId !== undefined && review.draftNote === null,
        canReplyToActiveNote: activeReplyableNoteId !== undefined && review.draftNote === null,
        canRefreshCurrentInput,
        alignCurrentLine,
        applyFilePresentationToAllMatching,
        focusFilter,
        editActiveNote: () => {
          if (activeEditableNoteId) startUserNoteEdit(activeEditableNoteId);
        },
        replyToActiveNote: () => {
          if (activeReplyableNoteId) startUserNoteReply(activeReplyableNoteId);
        },
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
      }).map((command) =>
        process.env.HUNK_RETURN_TO_HISTORY === "1" && command.id === "hunk.app.quit"
          ? { ...command, title: "Back to history" }
          : command,
      ),
      ...extensionAppCommands.commands,
    ],
    publishCommandExecuted,
  );
  useExtensionRuntimeBindings({
    commands: appCommands,
    navigation: extensionNavigationBindings,
    runtime: extensionRuntime,
  });

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
    const selection = getRenderExtensionSelection();
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
          review={bootstrap.review ?? null}
          files={filteredFiles}
          fileViews={getRenderExtensionFileViews()}
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
            pane.key === HUNK_FILES_PANE_KEY ? undefined : () => reportPaneRenderFailure(pane)
          }
        />
      </box>
    );
  };

  // OpenTUI normally chooses a drag target only after the pointer first moves. Capture on press
  // so a fast motion or a sidebar projection swap cannot transfer the gesture to a transient row.
  const beginCapturedPaneResize = (planned: PlannedPane, event: TuiMouseEvent) => {
    if (!beginPaneResize(planned, event)) return;
    if (paneResizeCaptureRef.current) {
      setMouseCapture(renderer, paneResizeCaptureRef.current);
    }
    closeMenu();
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
          isResizing={resizingPaneKey === planned.pane.key}
          theme={activeTheme}
          onMouseDown={(event) => beginCapturedPaneResize(planned, event)}
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
        ref={paneResizeCaptureRef}
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
            fileGap={fileGap}
            hunkGap={hunkGap}
            wrapLines={wrapLines}
            wrapToggleScrollTop={wrapToggleScrollTopRef.current}
            layoutToggleScrollTop={layoutToggleScrollTopRef.current}
            layoutToggleRequestId={layoutToggleRequestId}
            scrollEdgeRequest={scrollEdgeRequest}
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
            onEditUserNote={startUserNoteEdit}
            onReplyToNote={startUserNoteReply}
            onRemoveLiveNote={review.removeLiveComment}
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
            terminalHeight={terminal.height}
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

      {extensionTrustPromptOpen && extensionTrustPromptRoot ? (
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

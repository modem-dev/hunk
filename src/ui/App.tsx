import {
  MouseButton,
  type MouseEvent as TuiMouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  diffPersistedViewPreferences,
  saveGlobalViewPreferences,
  saveViewPreferencesPromptPreference,
} from "../core/config";
import { experimentalFeatureEnabled, resolveExperimentalDiffFiles } from "../core/experimental";
import { DEFAULT_TAB_WIDTH } from "../core/tabWidth";
import type {
  AppBootstrap,
  CliInput,
  CursorLine,
  LayoutMode,
  PersistedViewPreferences,
  UserNoteLineTarget,
} from "../core/types";
import { canReloadInput } from "../core/watch";
import { sanitizeTerminalLine } from "../lib/terminalText";
import { resolveExtensionCommands, resolveExtensionFileViews } from "../extensions/apply";
import {
  emitExtensionCustomEvent,
  emitExtensionEvent,
  toReadOnlyFileViews,
} from "../extensions/events";
import { writeExtensionTrust } from "../extensions/trust";
import type {
  ExtensionCommandContext,
  ExtensionEventContext,
  ExtensionFileViewControls,
  ExtensionReviewNote,
  ExtensionSidebarControls,
  RegisteredCommand,
} from "../extensions/types";
import type {
  HunkSessionBrokerClient,
  ReloadedSessionResult,
  ReloadSessionOptions,
} from "../session/types";
import { MenuBar } from "./components/chrome/MenuBar";
import { ConfirmDialog, confirmDialogHeight } from "./components/chrome/ConfirmDialog";
import { ExtensionDialog } from "./components/chrome/ExtensionDialog";
import { ExtensionToast } from "./components/chrome/ExtensionToast";
import { StatusBar } from "./components/chrome/StatusBar";
import { DiffPane } from "./components/panes/DiffPane";
import { ExtensionSidebarPane } from "./components/panes/ExtensionSidebarPane";
import { PaneDivider } from "./components/panes/PaneDivider";
import {
  findMaxLineNumber,
  maxFileCodeLineWidth,
  resolveCodeViewportWidth,
} from "./diff/codeColumns";
import type { ActiveAddNoteAffordance } from "./diff/PierreDiffView";
import { useAppKeyboardShortcuts } from "./hooks/useAppKeyboardShortcuts";
import { useExtensionDialogController } from "./hooks/useExtensionDialogController";
import { useExtensionNotifications } from "./hooks/useExtensionNotifications";
import { useHunkSessionBridge } from "./hooks/useHunkSessionBridge";
import { useMenuController } from "./hooks/useMenuController";
import { useReviewController, type AgentNoteGeometrySnapshot } from "./hooks/useReviewController";
import { useWatchedInput, type WatchedInputRuntime } from "./hooks/useWatchedInput";
import { agentNoteMarkupWidth } from "./lib/agentNoteGeometry";
import {
  buildAppCommands,
  builtinCommandKeyDefaults,
  builtinCommandMatchProbes,
} from "./lib/appCommands";
import { buildAppMenus } from "./lib/appMenus";
import { buildExtensionAppCommands, extensionCommandKeyDefaults } from "./lib/extensionCommands";
import { createGuardedReviewNavigation } from "./lib/extensionNavigation";
import type { LineCursor } from "./lib/lineCursors";
import { buildExtensionReviewSelection } from "./lib/extensionSelection";
import { useFileViewLayouts } from "./fileViews/useFileViews";
import type { FileViewRowFailure } from "./components/panes/FileView";
import { availableFileViewSelections, fileViewUnavailableReason } from "./fileViews/availability";
import {
  reconcileFileViewSelections,
  registeredFileViewKey,
  resolveBulkFileViewTarget,
  resolveRegisteredFileView,
  selectFileView,
  selectFileViewForFiles,
} from "./fileViews/state";
import { createExtensionSidebarKeybindings, resolveCommandKeys } from "./lib/keymap";
import {
  buildSessionSidebarViews,
  bundledSidebarViewKey,
  initialSidebarOpenState,
  planSidebarLayout,
  reconcileSidebarOpenState,
  resolveSidebarViewKey,
  type SidebarPanePlan,
  type SidebarPlacement,
} from "./lib/sidebarPanes";
import { nextExtensionTrustPromptRoot } from "./lib/extensionTrustPrompt";
import { openSelectedFileInEditor } from "./lib/openInEditor";
import { resolveResponsiveLayout } from "./lib/responsive";
import { resizeSidebarWidth } from "./lib/sidebar";
import { availableThemes, resolveTheme, withTransparentSurfaces } from "./themes";

/** Bound row-render warning metadata even if a large custom tree fails throughout scrolling. */
const FILE_VIEW_RENDER_FAILURE_MAX_ENTRIES = 256;

type FocusArea = "files" | "filter" | "note";
type ActiveAddNoteTarget = ActiveAddNoteAffordance & { fileId: string };
type ThemeSelectorState = {
  open: boolean;
  selectedIndex: number;
  previewThemeId: string | null;
};

const FAST_CODE_HORIZONTAL_SCROLL_COLUMNS = 8;
const EMPTY_LINE_CURSORS: LineCursor[] = [];

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
  watchRuntime,
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkSessionBrokerClient;
  noticeText?: string | null;
  onQuit?: () => void;
  onReloadSession: (
    nextInput: CliInput,
    options?: ReloadSessionOptions,
  ) => Promise<ReloadedSessionResult>;
  watchRuntime?: WatchedInputRuntime;
}) {
  const SIDEBAR_MIN_WIDTH = 22;
  const SIDEBAR_DEFAULT_WIDTH = 34;
  const DIFF_MIN_WIDTH = 48;
  const BODY_PADDING = 2;
  const DIVIDER_WIDTH = 1;
  const DIVIDER_HIT_WIDTH = 5;

  const pagerMode = Boolean(bootstrap.input.options.pager);
  const tabWidth = bootstrap.initialTabWidth ?? DEFAULT_TAB_WIDTH;
  const stmlEnabled = experimentalFeatureEnabled(bootstrap.input.options, "stml");
  const reviewFiles = useMemo(
    () => resolveExperimentalDiffFiles(bootstrap.changeset.files, bootstrap.input.options),
    [bootstrap.changeset.files, bootstrap.input.options.experimental],
  );
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
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
        bootstrap.customThemes,
      ).id,
  );
  // Soft reloads replace bootstrap without re-running startup terminal theme detection.
  const [detectedThemeMode] = useState(() => bootstrap.initialThemeMode);
  const [showAgentNotes, setShowAgentNotes] = useState(bootstrap.initialShowAgentNotes ?? false);
  const [showLineNumbers, setShowLineNumbers] = useState(bootstrap.initialShowLineNumbers ?? true);
  const [wrapLines, setWrapLines] = useState(bootstrap.initialWrapLines ?? false);
  const [copyDecorations, setCopyDecorations] = useState(bootstrap.initialCopyDecorations ?? false);
  const [codeHorizontalOffset, setCodeHorizontalOffset] = useState(0);
  const [cursorLine, setCursorLine] = useState<CursorLine>(bootstrap.initialCursorLine ?? "row");
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
  const [saveConfigPromptOpen, setSaveConfigPromptOpen] = useState(false);
  const [focusArea, setFocusArea] = useState<FocusArea>("files");
  const [activeAddNoteTarget, setActiveAddNoteTarget] = useState<ActiveAddNoteTarget | null>(null);
  const [sidebarWidths, setSidebarWidths] = useState<Record<string, number>>({});
  const [sidebarResize, setSidebarResize] = useState<{
    key: string;
    placement: SidebarPlacement;
    originX: number;
    startWidth: number;
    maxWidth: number;
  } | null>(null);
  const [sessionNoticeText, setSessionNoticeText] = useState<string | null>(null);
  const sessionNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const extensions = bootstrap.extensions;
  const pendingTrustRepoRoot = extensions?.pendingTrustRepoRoot;
  const extensionToast = useExtensionNotifications(extensions?.notifications);
  // Repo-local extensions were discovered but skipped for want of a trust
  // decision. The prompt tracks the pending root reactively, because a session
  // reload can point this app at a different repository without remounting.
  const [extensionTrustPromptRoot, setExtensionTrustPromptRoot] = useState<string | null>(null);
  const offeredTrustRepoRootsRef = useRef<Set<string>>(new Set());
  const extensionTrustPromptOpen = extensionTrustPromptRoot !== null;

  const themeOptions = useMemo(
    () => availableThemes(bootstrap.customThemes),
    [bootstrap.customThemes],
  );
  const effectiveThemeId = themeSelectorState.previewThemeId ?? themeId;
  const baseTheme = useMemo(
    () => resolveTheme(effectiveThemeId, detectedThemeMode ?? null, bootstrap.customThemes),
    [effectiveThemeId, detectedThemeMode, bootstrap.customThemes],
  );
  const activeTheme = useMemo(
    () =>
      bootstrap.input.options.transparentBackground
        ? withTransparentSurfaces(baseTheme)
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
  const initialViewPreferencesRef = useRef(currentViewPreferences);
  const changedViewPreferences = useMemo(
    () => diffPersistedViewPreferences(initialViewPreferencesRef.current, currentViewPreferences),
    [currentViewPreferences],
  );
  // Render each change as the -/+ pair of TOML assignments the save would rewrite,
  // with the key column aligned across all changed preferences.
  const viewPreferenceDiffLines = useMemo(() => {
    const keyWidth = changedViewPreferences.reduce(
      (width, change) => Math.max(width, change.configKey.length),
      0,
    );
    return changedViewPreferences.flatMap((change) => [
      { removed: true, text: `- ${change.configKey.padEnd(keyWidth)} = ${change.previousValue}` },
      { removed: false, text: `+ ${change.configKey.padEnd(keyWidth)} = ${change.nextValue}` },
    ]);
  }, [changedViewPreferences]);
  const hasUnsavedViewPreferences = changedViewPreferences.length > 0;
  const viewPreferencesConfigLabel = useMemo(() => {
    const path = bootstrap.viewPreferencesConfigPath ?? "~/.config/hunk/config.toml";
    return process.env.HOME && path.startsWith(process.env.HOME)
      ? `~${path.slice(process.env.HOME.length)}`
      : path;
  }, [bootstrap.viewPreferencesConfigPath]);
  // App computes layout geometry below this hook call, so the controller reads
  // the current values through a ref instead of a render-time parameter.
  const noteGeometryRef = useRef<AgentNoteGeometrySnapshot | null>(null);
  // The diff pane measures the review stream, so it is the one that can enumerate navigable lines.
  const [lineCursors, setLineCursors] = useState<LineCursor[]>(EMPTY_LINE_CURSORS);
  const review = useReviewController({
    files: reviewFiles,
    lineCursors,
    noteGeometry: noteGeometryRef,
    stmlEnabled,
  });
  const filteredFiles = review.visibleFiles;
  const selectedFile = review.selectedFile;
  const selectedHunkIndex = review.selectedHunkIndex;
  const selectedFileId = selectedFile?.id ?? null;
  // File presentations are per-file, survive filtering, and are reconciled against a reload's
  // stable ids. Raw is implicit, so an empty state is the guaranteed default/fallback.
  const sessionFileViews = useMemo(
    () => (extensions ? resolveExtensionFileViews(extensions.registry).views : []),
    [extensions],
  );
  const [fileViewSelections, setFileViewSelections] = useState<Record<string, string>>({});
  const fileViewSelectionsRef = useRef(fileViewSelections);
  fileViewSelectionsRef.current = fileViewSelections;
  const sessionFileViewsRef = useRef(sessionFileViews);
  sessionFileViewsRef.current = sessionFileViews;
  const fileViewUnavailableReasons = useMemo(() => {
    const reasons = new Map<string, string>();
    for (const file of filteredFiles) {
      const reason = fileViewUnavailableReason({
        hasDraftNote: review.draftNote?.fileId === file.id,
      });
      if (reason) reasons.set(file.id, reason);
    }
    return reasons;
  }, [filteredFiles, review.draftNote?.fileId]);
  const fileViewUnavailableReasonsRef = useRef(fileViewUnavailableReasons);
  fileViewUnavailableReasonsRef.current = fileViewUnavailableReasons;
  const availableFileViewSelectionState = useMemo(
    () => availableFileViewSelections(fileViewSelections, fileViewUnavailableReasons),
    [fileViewSelections, fileViewUnavailableReasons],
  );
  useEffect(() => {
    const viewKeys = new Set(sessionFileViews.map(registeredFileViewKey));
    setFileViewSelections((current) =>
      reconcileFileViewSelections(
        current,
        reviewFiles.map((file) => file.id),
        viewKeys,
      ),
    );
  }, [reviewFiles, sessionFileViews]);
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
  const extensionSelectionInputsRef = useRef({ filteredFiles, selectedFileId, selectedHunkIndex });
  extensionSelectionInputsRef.current = { filteredFiles, selectedFileId, selectedHunkIndex };
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
  });
  // A hard session reload (`resetApp`) remounts App under an in-flight async
  // command handler, whose `ctx.navigation` closes over *this* instance's
  // refs. Flipping this on unmount lets those closures refuse with an accurate
  // warning instead of validating against the dead instance's file list or
  // driving a controller whose state updates no longer render.
  const appAliveForNavigationRef = useRef(true);
  useEffect(
    () => () => {
      appAliveForNavigationRef.current = false;
    },
    [],
  );

  /** Build the selection snapshot a command handler receives, at invocation. */
  const getExtensionSelection = useCallback(() => {
    const { selectedFileId: fileId, selectedHunkIndex: hunkIndex } =
      extensionSelectionInputsRef.current;
    return buildExtensionReviewSelection({
      files: getExtensionFileViews(),
      selectedFileId: fileId,
      selectedHunkIndex: hunkIndex,
    });
  }, [getExtensionFileViews]);
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

  useEffect(() => {
    // Every load produces a fresh changeset object, so this covers the first
    // review plus soft reloads; hard reloads remount App and land here again.
    emitExtensionEvent(extensions, "changeset_loaded", { changeset: bootstrap.changeset });
  }, [bootstrap.changeset, extensions]);

  // Every sidebar view this session offers — the bundled file navigation plus
  // each registered view — and which of them are open. Registration is
  // additive; the built-in sidebar is itself a bundled extension, so every
  // pane renders through the extension path.
  const sessionSidebarViews = useMemo(() => buildSessionSidebarViews(extensions), [extensions]);
  const [sidebarOpenState, setSidebarOpenState] = useState(() =>
    initialSidebarOpenState(sessionSidebarViews),
  );
  useEffect(() => {
    // Reloads may add or remove views; keep the user's open/closed choices for
    // the ones that survived.
    setSidebarOpenState((current) => reconcileSidebarOpenState(sessionSidebarViews, current));
  }, [sessionSidebarViews]);
  const sessionSidebarViewsRef = useRef(sessionSidebarViews);
  sessionSidebarViewsRef.current = sessionSidebarViews;
  const sidebarOpenStateRef = useRef(sidebarOpenState);
  sidebarOpenStateRef.current = sidebarOpenState;

  const setSidebarOpen = useCallback((key: string, nextOpen: boolean | "toggle") => {
    setSidebarOpenState((current) => {
      const isOpen = current.open.includes(key);
      const resolved = nextOpen === "toggle" ? !isOpen : nextOpen;
      if (resolved === isOpen) {
        return current;
      }

      return {
        known: current.known,
        open: resolved ? [...current.open, key] : current.open.filter((open) => open !== key),
      };
    });
  }, []);

  /** Close a sidebar view that failed rendering; never leave the area empty. */
  const handleSidebarViewFailure = useCallback((key: string) => {
    setSidebarOpenState((current) => {
      const open = current.open.filter((openKey) => openKey !== key);
      return {
        known: current.known,
        open: open.length > 0 ? open : [bundledSidebarViewKey()],
      };
    });
  }, []);

  /** Build the sidebar controls one extension's command handlers receive. */
  const createSidebarControls = useCallback(
    (extensionId: string): ExtensionSidebarControls => {
      const resolve = (method: string, viewId: string) => {
        const key = resolveSidebarViewKey(sessionSidebarViewsRef.current, extensionId, viewId);
        if (!key) {
          extensions?.context.notify(
            `Extension ${extensionId} ${method} targeted unknown sidebar view "${viewId}"`,
            "warning",
          );
        }

        return key;
      };

      return {
        open(viewId: string) {
          const key = resolve("sidebars.open", viewId);
          if (key) {
            setSidebarOpen(key, true);
            // Opening a view is a request to *see* it: a sidebar area the
            // user hid with `s` reveals again, or the open would be silent.
            revealSidebarAreaRef.current();
          }
        },
        close(viewId: string) {
          const key = resolve("sidebars.close", viewId);
          if (key) {
            setSidebarOpen(key, false);
          }
        },
        toggle(viewId: string) {
          const key = resolve("sidebars.toggle", viewId);
          if (key) {
            const willOpen = !sidebarOpenStateRef.current.open.includes(key);
            setSidebarOpen(key, "toggle");
            if (willOpen) {
              revealSidebarAreaRef.current();
            }
          }
        },
        isOpen(viewId: string) {
          const key = resolveSidebarViewKey(sessionSidebarViewsRef.current, extensionId, viewId);
          return key !== undefined && sidebarOpenStateRef.current.open.includes(key);
        },
      };
    },
    [extensions, setSidebarOpen],
  );

  /** Build host-owned file-presentation controls for one extension command. */
  const createFileViewControls = useCallback(
    (extensionId: string): ExtensionFileViewControls => {
      const resolve = (viewId: string) =>
        resolveRegisteredFileView(sessionFileViewsRef.current, extensionId, viewId);
      const selectedId = () => extensionSelectionInputsRef.current.selectedFileId;
      const select = (viewId: string | null) => {
        const fileId = selectedId();
        if (!fileId) {
          showSessionNotice(
            `Extension ${extensionId} cannot select a file view without a selected file`,
          );
          return;
        }
        const unavailableReason = fileViewUnavailableReasonsRef.current.get(fileId);
        if (viewId !== null && unavailableReason) {
          showSessionNotice(unavailableReason);
          return;
        }
        const registered = viewId === null ? undefined : resolve(viewId);
        if (viewId !== null && !registered) {
          showSessionNotice(`Extension ${extensionId} targeted unknown file view "${viewId}"`);
          return;
        }
        if (registered) {
          const selected = getExtensionSelection().file;
          try {
            if (!selected || !registered.view.matches(selected)) {
              showSessionNotice(
                `File view "${viewId}" does not match the selected file • using raw diff`,
              );
              return;
            }
          } catch {
            showSessionNotice(
              `Extension ${registered.extensionId} file view "${registered.view.id}" failed matching the selected file`,
            );
            return;
          }
        }
        setFileViewSelections((current) =>
          selectFileView(current, fileId, registered ? registeredFileViewKey(registered) : null),
        );
      };
      return {
        select,
        toggle(viewId: string) {
          const registered = resolve(viewId);
          const fileId = selectedId();
          if (fileId && fileViewUnavailableReasonsRef.current.has(fileId)) {
            select(viewId);
            return;
          }
          if (
            fileId &&
            registered &&
            fileViewSelectionsRef.current[fileId] === registeredFileViewKey(registered)
          ) {
            select(null);
          } else {
            select(viewId);
          }
        },
        isActive(viewId: string) {
          const registered = resolve(viewId);
          const fileId = selectedId();
          return Boolean(
            fileId &&
            !fileViewUnavailableReasonsRef.current.has(fileId) &&
            registered &&
            fileViewSelectionsRef.current[fileId] === registeredFileViewKey(registered),
          );
        },
      };
    },
    [getExtensionSelection, showSessionNotice],
  );

  /**
   * Reveal the sidebar area, assigned each render once the responsive layout
   * is known (the controls above are created before it is computed).
   */
  const revealSidebarAreaRef = useRef<() => void>(() => {});

  const {
    accept: acceptExtensionDialog,
    cancel: cancelExtensionDialog,
    createDialogs: createExtensionDialogs,
    inputValue: extensionDialogInputValue,
    moveSelection: moveExtensionDialogSelection,
    pickOption: setExtensionDialogSelectedIndex,
    request: extensionDialog,
    selectedIndex: extensionDialogSelectedIndex,
    updateInput: setExtensionDialogInputValue,
  } = useExtensionDialogController({ reviewGeneration: bootstrap });

  // Lifecycle and bus listeners receive the same sidebar controls as commands,
  // so an extension can react to loaded content by revealing its own pane.
  if (extensions) {
    extensions.eventContextProvider = (extensionId): ExtensionEventContext => ({
      cwd: extensions.context.cwd,
      notify: (message, type) => extensions.context.notify(message, type),
      sidebars: createSidebarControls(extensionId),
      events: {
        emit(event, payload) {
          emitExtensionCustomEvent(extensions, event, payload);
        },
      },
    });
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
      const ctx: ExtensionCommandContext = {
        cwd: extensions?.context.cwd ?? process.cwd(),
        notify: (message, type) => extensions?.context.notify(message, type),
        sidebars: createSidebarControls(registered.extensionId),
        fileViews: createFileViewControls(registered.extensionId),
        // Snapshot semantics: built when the key fires, so the handler sees
        // where the review was at that moment, even if it awaits and the user
        // navigates on.
        selection: getExtensionSelection(),
        // Bound to the requesting extension for attribution, and valid for the
        // whole life of the handler's promise — a handler may ask several
        // questions in sequence with work between them.
        dialogs: createExtensionDialogs(registered.extensionId),
        // Live, unlike `selection`: reads the visible files and delegates to
        // the same focus/jump callbacks a sidebar row click runs, so a handler
        // that awaits a dialog before navigating still acts on the current
        // review — validated, clamped, and warned exactly like sidebar actions.
        navigation: createGuardedReviewNavigation({
          extensionId: registered.extensionId,
          getFiles: () => extensionSelectionInputsRef.current.filteredFiles,
          // Extensions outlive App remounts, so the notify sink stays valid
          // even after this instance dies and `isLive` starts refusing calls.
          isLive: () => appAliveForNavigationRef.current,
          notify: (message, type) => extensions?.context.notify(message, type),
          onSelectFile: (fileId) => extensionCommandNavigationRef.current.onSelectFile(fileId),
          onSelectHunk: (fileId, hunkIndex) =>
            extensionCommandNavigationRef.current.onSelectHunk(fileId, hunkIndex),
        }),
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
      createFileViewControls,
      createSidebarControls,
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
  // Sidebar views receive the dispatcher’s effective keys, including command
  // conflicts, rather than independently resolving their default bindings.
  const sidebarKeybindings = useMemo(() => {
    const effectiveKeys = new Map(resolvedCommandKeys);
    for (const command of extensionAppCommands.commands) {
      effectiveKeys.set(command.id, command.keys);
    }
    return createExtensionSidebarKeybindings(effectiveKeys);
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
  const canForceShowSidebar = bodyWidth >= SIDEBAR_MIN_WIDTH + DIVIDER_WIDTH + DIFF_MIN_WIDTH;
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
  const sidebarLayout = useMemo(
    () =>
      sidebarAreaVisible
        ? planSidebarLayout({
            views: sessionSidebarViews,
            openKeys: sidebarOpenState.open,
            widths: sidebarWidths,
            defaultWidth: SIDEBAR_DEFAULT_WIDTH,
            minWidth: SIDEBAR_MIN_WIDTH,
            dividerWidth: DIVIDER_WIDTH,
            bodyWidth,
            diffMinWidth: DIFF_MIN_WIDTH,
          })
        : { left: [], right: [], totalWidth: 0, leftWidth: 0 },
    [
      bodyWidth,
      DIFF_MIN_WIDTH,
      DIVIDER_WIDTH,
      SIDEBAR_DEFAULT_WIDTH,
      SIDEBAR_MIN_WIDTH,
      sessionSidebarViews,
      sidebarAreaVisible,
      sidebarOpenState.open,
      sidebarWidths,
    ],
  );
  const renderSidebar = sidebarLayout.left.length + sidebarLayout.right.length > 0;
  const diffPaneWidth = Math.max(DIFF_MIN_WIDTH, bodyWidth - sidebarLayout.totalWidth);
  const diffContentWidth = Math.max(12, diffPaneWidth - 2);
  // Mirrors toggleSidebar's reveal half: visible again, forced open when the
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
  const reportedFileViewRowFailuresRef = useRef(
    new Map<string, { fileId: string; layoutGeneration: number }>(),
  );
  /** Attribute synchronous row failures through the existing extension warning surface. */
  const reportFileViewRowFailure = useCallback(
    (failure: FileViewRowFailure) => {
      const dedupeKey = [
        failure.extensionId,
        failure.viewId,
        failure.fileId,
        failure.rowId,
        failure.layoutGeneration,
        failure.message,
      ].join("\u0000");
      const reported = reportedFileViewRowFailuresRef.current;
      if (reported.has(dedupeKey)) return;
      reported.set(dedupeKey, {
        fileId: failure.fileId,
        layoutGeneration: failure.layoutGeneration,
      });
      if (reported.size > FILE_VIEW_RENDER_FAILURE_MAX_ENTRIES) {
        const oldest = reported.keys().next().value;
        if (oldest !== undefined) reported.delete(oldest);
      }
      extensions?.context.notify(
        `Extension ${failure.extensionId} file view "${failure.viewId}" row "${failure.rowId}" failed rendering ${failure.filePath} • ${failure.message}`,
        "warning",
      );
    },
    [extensions],
  );
  const fileViewLayouts = useFileViewLayouts({
    files: filteredFiles,
    selections: availableFileViewSelectionState,
    views: sessionFileViews,
    width: diffContentWidth,
    onIssue: showSessionNotice,
  });
  useEffect(() => {
    const activeGenerations = new Set(
      Array.from(fileViewLayouts, ([fileId, layout]) =>
        [fileId, layout.layoutGeneration].join("\u0000"),
      ),
    );
    for (const [key, failure] of reportedFileViewRowFailuresRef.current) {
      if (!activeGenerations.has([failure.fileId, failure.layoutGeneration].join("\u0000"))) {
        reportedFileViewRowFailuresRef.current.delete(key);
      }
    }
  }, [fileViewLayouts]);

  useHunkSessionBridge({
    addLiveComment: review.addLiveComment,
    addLiveCommentBatch: review.addLiveCommentBatch,
    clearLiveComments: review.clearLiveComments,
    hostClient,
    liveCommentCount: review.liveCommentCount,
    liveCommentSummaries: review.liveCommentSummaries,
    navigateToLocation: review.navigateToLocation,
    noteMarkupWidth: stmlEnabled ? noteMarkupWidth : undefined,
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
  const isResizingSidebar = sidebarResize !== null;

  useEffect(() => {
    if (!renderSidebar) {
      setSidebarResize(null);
    }
  }, [renderSidebar]);

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

  /** Step one line: move the current line, or scroll the viewport when there is no marker. */
  const stepDiffLine = (delta: number) => {
    // Changesets with no navigable lines, such as binary-only reviews, still have to scroll.
    if (cursorLine === "off" || !review.lineCursor) {
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

  /** Choose how the review stream marks the line the reviewer is on. */
  const selectCursorLine = useCallback((style: CursorLine) => {
    setCursorLine(style);
  }, []);

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

  const reportedThemeIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (reportedThemeIdRef.current !== undefined && reportedThemeIdRef.current !== themeId) {
      emitExtensionEvent(extensions, "theme_changed", { themeId });
    }
    reportedThemeIdRef.current = themeId;
  }, [extensions, themeId]);

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
  const refreshCurrentInput = useCallback(
    async (options?: Pick<ReloadSessionOptions, "reason" | "reloadExtensions">) => {
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
        ...options,
        resetApp: false,
        sourcePath:
          bootstrap.input.kind === "vcs" ||
          bootstrap.input.kind === "show" ||
          bootstrap.input.kind === "stash-show"
            ? bootstrap.changeset.sourceLabel
            : undefined,
      });
    },
    [
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
    ],
  );

  const triggerRefreshCurrentInput = useCallback(() => {
    void refreshCurrentInput({ reason: "manual" }).catch((error) => {
      console.error("Failed to reload the current diff.", error);
    });
  }, [refreshCurrentInput]);

  /** Reload because the watcher saw the reviewed source change on disk. */
  const refreshWatchedInput = useCallback(
    () => refreshCurrentInput({ reason: "watch" }),
    [refreshCurrentInput],
  );

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

  useWatchedInput({
    enabled: watchEnabled,
    input: bootstrap.input,
    onReloadPending: () => emitExtensionEvent(extensions, "watch_reload_pending", {}),
    refresh: refreshWatchedInput,
    reloadContext: bootstrap.reloadContext,
    runtime: watchRuntime,
  });

  /** Save current view preferences to user config and then leave the app. */
  const saveViewPreferencesAndQuit = useCallback(() => {
    try {
      const configPath = saveGlobalViewPreferences(currentViewPreferences, {
        configPath: bootstrap.viewPreferencesConfigPath,
      });
      initialViewPreferencesRef.current = currentViewPreferences;
      showSessionNotice(`Saved view preferences to ${configPath}`);
      setTimeout(onQuit, 120);
    } catch (error) {
      showSessionNotice(
        error instanceof Error ? error.message : "Failed to save view preferences.",
      );
    }
  }, [bootstrap.viewPreferencesConfigPath, currentViewPreferences, onQuit, showSessionNotice]);

  /** Leave the app without writing view preference changes. */
  const discardViewPreferencesAndQuit = useCallback(() => {
    setSaveConfigPromptOpen(false);
    onQuit();
  }, [onQuit]);

  /** Persist the user's choice to stop prompting about view preference changes. */
  const neverAskToSaveViewPreferencesAndQuit = useCallback(() => {
    try {
      const configPath = saveViewPreferencesPromptPreference(false, {
        configPath: bootstrap.viewPreferencesConfigPath,
      });
      showSessionNotice(`Won't ask to save view preferences again (${configPath})`);
      setTimeout(onQuit, 120);
    } catch (error) {
      showSessionNotice(
        error instanceof Error ? error.message : "Failed to save prompt preference.",
      );
    }
  }, [bootstrap.viewPreferencesConfigPath, onQuit, showSessionNotice]);

  /** Leave the app through the shared shutdown path, prompting before discarding view changes. */
  const requestQuit = useCallback(() => {
    if (
      !pagerMode &&
      bootstrap.input.options.promptSaveViewPreferences !== false &&
      hasUnsavedViewPreferences
    ) {
      setShowHelp(false);
      setSaveConfigPromptOpen(true);
      return;
    }

    onQuit();
  }, [
    bootstrap.input.options.promptSaveViewPreferences,
    hasUnsavedViewPreferences,
    onQuit,
    pagerMode,
  ]);

  const closeSaveConfigPrompt = useCallback(() => {
    setSaveConfigPromptOpen(false);
  }, []);

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

  // Command-handler navigation lands here each render: the same focus and jump
  // semantics the sidebar's onSelect handlers use, so a command's navigation is
  // indistinguishable from a sidebar row click. Read through a ref because the
  // command dispatch table is built above these helpers and must stay
  // identity-stable while the review moves.
  extensionCommandNavigationRef.current = {
    onSelectFile: (fileId) => {
      focusFiles();
      jumpToFile(fileId, 0, { alignFileHeaderTop: true });
    },
    onSelectHunk: (fileId, hunkIndex) => {
      focusFiles();
      review.selectHunk(fileId, hunkIndex);
    },
  };

  /** Toggle keyboard focus between the file list and the file filter. */
  const toggleFocusArea = useCallback(() => {
    setFocusArea((current) => (current === "files" ? "filter" : "files"));
  }, []);

  /** Start a user-authored inline note and move keyboard focus into it. */
  const startUserNote = useCallback(
    (fileId?: string, hunkIndex?: number, target?: UserNoteLineTarget) => {
      // A live hover is the more recent intent, so it outranks the resting current line.
      const restingTarget = cursorLine === "off" ? null : review.lineCursor;
      const hoverTarget = fileId === undefined ? activeAddNoteTarget : null;
      const keyboardTarget = fileId === undefined ? (hoverTarget ?? restingTarget) : null;
      const draft = review.startUserNote(
        fileId ?? keyboardTarget?.fileId,
        hunkIndex ?? keyboardTarget?.hunkIndex,
        target ?? keyboardTarget?.target,
        // A pointer-placed note is already on screen; one placed from the current line may not be.
        { preserveViewport: fileId !== undefined || hoverTarget !== null },
      );
      if (draft) {
        setActiveAddNoteTarget(null);
        setFocusArea("note");
      }
    },
    [activeAddNoteTarget, cursorLine, review.lineCursor, review.startUserNote],
  );

  /** Mark the inline draft note textarea as the active keyboard input. */
  const focusDraftNote = useCallback(() => {
    setFocusArea("note");
  }, []);

  /** Return keyboard focus to review navigation when the draft textarea loses focus. */
  const blurDraftNote = useCallback(() => {
    setFocusArea((current) => (current === "note" ? "files" : current));
  }, []);

  /** Convert a draft or saved UI note into the stable public event view. */
  const toExtensionReviewNote = useCallback(
    (
      note: {
        id: string;
        fileId: string;
        filePath: string;
        hunkIndex: number;
        side: "old" | "new";
        line: number;
        body?: string;
        summary?: string;
      },
      draft: boolean,
    ): ExtensionReviewNote => ({
      id: note.id,
      fileId: note.fileId,
      filePath: note.filePath,
      hunkIndex: note.hunkIndex,
      side: note.side,
      line: note.line,
      body: note.body ?? note.summary ?? "",
      draft,
    }),
    [],
  );

  /** Save the active draft note and return focus to review navigation. */
  const saveDraftNote = useCallback(() => {
    const draft = review.draftNote;
    const saved = review.saveDraftNote();
    if (saved && draft) {
      emitExtensionEvent(extensions, "note_created", {
        note: toExtensionReviewNote({ ...saved, fileId: draft.fileId }, false),
      });
    }
    setFocusArea("files");
  }, [extensions, review.draftNote, review.saveDraftNote, toExtensionReviewNote]);

  /** Update a draft note and publish its current in-progress contents. */
  const updateDraftNote = useCallback(
    (body: string) => {
      const draft = review.draftNote;
      review.updateDraftNote(body);
      if (draft) {
        emitExtensionEvent(extensions, "note_edited", {
          note: toExtensionReviewNote({ ...draft, body }, true),
        });
      }
    },
    [extensions, review.draftNote, review.updateDraftNote, toExtensionReviewNote],
  );

  /** Cancel the active draft note and return focus to review navigation. */
  const cancelDraftNote = useCallback(() => {
    review.cancelDraftNote();
    setFocusArea("files");
  }, [review.cancelDraftNote]);

  const reviewFileViewsForBulkSelection = useMemo(
    () => toReadOnlyFileViews(reviewFiles),
    [reviewFiles],
  );
  const selectedFileViewBulkTarget = useMemo(() => {
    if (!selectedFile || fileViewUnavailableReasons.has(selectedFile.id)) return null;
    const key = fileViewSelections[selectedFile.id];
    if (!key) return null;
    const registered = sessionFileViews.find((view) => registeredFileViewKey(view) === key);
    if (!registered) return null;

    const target = resolveBulkFileViewTarget({
      current: fileViewSelections,
      files: reviewFileViewsForBulkSelection,
      registered,
      selectedFileId: selectedFile.id,
    });
    return target
      ? { key: target.key, matchingFileIds: target.fileIds, title: registered.view.title }
      : null;
  }, [
    fileViewSelections,
    fileViewUnavailableReasons,
    reviewFileViewsForBulkSelection,
    selectedFile,
    sessionFileViews,
  ]);
  const applyFilePresentationToAllMatching = useCallback(() => {
    if (!selectedFileViewBulkTarget) return;
    setFileViewSelections((current) =>
      selectFileViewForFiles(
        current,
        selectedFileViewBulkTarget.matchingFileIds,
        selectedFileViewBulkTarget.key,
      ),
    );
  }, [selectedFileViewBulkTarget]);

  // One dispatch table for every app-level shortcut: the built-in commands
  // over App's live callbacks, then extension commands, so built-ins always
  // win a key and extension order follows load order.
  const appCommands = [
    ...buildAppCommands({
      canApplyFilePresentationToAllMatching: selectedFileViewBulkTarget !== null,
      canRefreshCurrentInput,
      applyFilePresentationToAllMatching,
      focusFilter,
      moveToAnnotatedFile,
      moveToAnnotatedHunk,
      moveToFile,
      moveToHunk: review.moveToHunk,
      openAgentSkill,
      openThemeSelector,
      requestQuit,
      resolvedKeys: resolvedCommandKeys,
      scrollCodeHorizontally,
      scrollDiff,
      stepDiffLine,
      selectCursorLine,
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
      toggleSidebar,
      triggerEditSelectedFile,
      triggerRefreshCurrentInput,
    }),
    ...extensionAppCommands.commands,
  ];

  const selectedFileViewEntries = useMemo(() => {
    if (!selectedFile) return [];
    const publicFile = getExtensionFileViews().find((file) => file.id === selectedFile.id);
    if (!publicFile) return [];
    const unavailableReason = fileViewUnavailableReasons.get(selectedFile.id);
    const active = unavailableReason ? undefined : fileViewSelections[selectedFile.id];
    const entries = [
      {
        kind: "item" as const,
        label: "File presentation: Raw diff",
        commandId: "hunk.view.filePresentation.raw",
        checked: active === undefined,
        action: () =>
          setFileViewSelections((current) => selectFileView(current, selectedFile.id, null)),
      },
    ];
    if (unavailableReason) return entries;
    for (const registered of sessionFileViews) {
      try {
        if (!registered.view.matches(publicFile)) continue;
      } catch {
        continue;
      }
      const key = registeredFileViewKey(registered);
      entries.push({
        kind: "item" as const,
        label: `File presentation: ${registered.view.title}`,
        commandId: `hunk.view.filePresentation.${key}`,
        checked: active === key,
        action: () =>
          setFileViewSelections((current) => selectFileView(current, selectedFile.id, key)),
      });
    }
    return entries;
  }, [
    fileViewSelections,
    fileViewUnavailableReasons,
    getExtensionFileViews,
    selectedFile,
    sessionFileViews,
  ]);

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
    copyDecorations,
    layoutMode,
    renderSidebar,
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
    themeSelectorOpen: themeSelectorState.open,
  });

  /** Start a mouse drag resize for one sidebar pane's divider. */
  const beginSidebarResize =
    (key: string, placement: SidebarPlacement, currentWidth: number) => (event: TuiMouseEvent) => {
      if (event.button !== MouseButton.LEFT) {
        return;
      }

      closeMenu();
      setSidebarResize({
        key,
        placement,
        originX: event.x,
        startWidth: currentWidth,
        // The pane may grow by whatever the review stream can give up.
        maxWidth: currentWidth + Math.max(0, diffPaneWidth - DIFF_MIN_WIDTH),
      });
      event.preventDefault();
      event.stopPropagation();
    };

  /** Update the dragged pane's width while a resize is active. */
  const updateSidebarResize = (event: TuiMouseEvent) => {
    if (!sidebarResize) {
      return;
    }

    const { key, placement, originX, startWidth, maxWidth } = sidebarResize;
    // A right-side pane's divider is its left edge, so the drag delta inverts:
    // swapping origin and current feeds the same clamp the mirrored motion.
    const nextWidth =
      placement === "right"
        ? resizeSidebarWidth(startWidth, event.x, originX, SIDEBAR_MIN_WIDTH, maxWidth)
        : resizeSidebarWidth(startWidth, originX, event.x, SIDEBAR_MIN_WIDTH, maxWidth);
    setSidebarWidths((current) =>
      current[key] === nextWidth ? current : { ...current, [key]: nextWidth },
    );
    event.preventDefault();
    event.stopPropagation();
  };

  /** End the current sidebar resize interaction. */
  const endSidebarResize = (event?: TuiMouseEvent) => {
    if (!isResizingSidebar) {
      return;
    }

    setSidebarResize(null);
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
  const diffHeaderStatsWidth = Math.min(24, Math.max(16, Math.floor(diffContentWidth / 3)));
  const diffHeaderLabelWidth = Math.max(8, diffContentWidth - diffHeaderStatsWidth - 1);
  const diffSeparatorWidth = Math.max(4, diffContentWidth - 2);
  // Mirror the App layout: bodyPadding/2 left-padding, then every left pane
  // plus its divider. Keep this in lockstep with the body container's
  // paddingLeft and the sidebar render branch below.
  const diffPaneScreenLeft = bodyPadding / 2 + sidebarLayout.leftWidth;
  const diffPaneScreenTop = showMenuBar ? 1 : 0;

  /** Render one open sidebar view at its planned width. */
  const renderSidebarPane = (pane: SidebarPanePlan) => {
    // Resolved here so hidden sidebars never pay for the conversion; the
    // per-source cache hands every pane (and command snapshots) one list.
    const paneSelection = getExtensionSelection();
    return (
      <ExtensionSidebarPane
        registered={pane.view.registered}
        files={filteredFiles}
        fileViews={getExtensionFileViews()}
        selectedFileId={paneSelection.file?.id ?? null}
        selectedHunkIndex={paneSelection.hunkIndex}
        showTopChrome={showMenuBar}
        theme={activeTheme}
        width={pane.width}
        keybindings={sidebarKeybindings}
        notify={(message, type) => extensions?.context.notify(message, type)}
        onSelectFile={(fileId) => {
          focusFiles();
          jumpToFile(fileId, 0, { alignFileHeaderTop: true });
        }}
        onSelectHunk={(fileId, hunkIndex) => {
          focusFiles();
          review.selectHunk(fileId, hunkIndex);
        }}
        // Extension panes close on a render failure; the bundled files pane is
        // Hunk's own and keeps its in-place fallback semantics.
        onRenderFailure={
          pane.view.key === bundledSidebarViewKey()
            ? undefined
            : () => handleSidebarViewFailure(pane.view.key)
        }
      />
    );
  };

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
        {sidebarLayout.left.map((pane, index) => {
          // Each left pane is followed by its own draggable divider; the hit
          // zone tracks the divider's absolute column inside the body row.
          const paneLeft =
            bodyPadding / 2 +
            sidebarLayout.left
              .slice(0, index)
              .reduce((sum, previous) => sum + previous.width + DIVIDER_WIDTH, 0);
          const dividerX = paneLeft + pane.width;
          return (
            <Fragment key={pane.view.key}>
              {renderSidebarPane(pane)}
              <PaneDivider
                dividerHitLeft={Math.max(
                  1,
                  dividerX - Math.floor((DIVIDER_HIT_WIDTH - DIVIDER_WIDTH) / 2),
                )}
                dividerHitWidth={DIVIDER_HIT_WIDTH}
                isResizing={sidebarResize?.key === pane.view.key}
                theme={activeTheme}
                onMouseDown={beginSidebarResize(pane.view.key, "left", pane.width)}
                onMouseDrag={updateSidebarResize}
                onMouseDragEnd={endSidebarResize}
                onMouseUp={endSidebarResize}
              />
            </Fragment>
          );
        })}

        <DiffPane
          cancelCopySelectionRef={cancelCopySelectionRef}
          codeHorizontalOffset={codeHorizontalOffset}
          copyDecorations={copyDecorations}
          diffContentWidth={diffContentWidth}
          expandedGapsByFileId={review.expandedGapsByFileId}
          fileViews={fileViewLayouts}
          files={filteredFiles}
          pagerMode={pagerMode}
          screenLeft={diffPaneScreenLeft}
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
          lineCursorRevealRequestId={review.lineCursorRevealRequestId}
          theme={activeTheme}
          width={diffPaneWidth}
          onActiveAddNoteAffordanceChange={setActiveAddNoteTarget}
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
            review.selectHunk(fileId, hunkIndex, { preserveViewport: true })
          }
          onLineCursorsChange={setLineCursors}
          onViewportLineCursorChange={review.anchorLineCursor}
        />

        {sidebarLayout.right.map((pane, index) => {
          // Right panes sit after the review stream; each is preceded by its
          // divider, and dragging that divider left grows the pane.
          const dividerX =
            bodyPadding / 2 +
            sidebarLayout.leftWidth +
            diffPaneWidth +
            sidebarLayout.right
              .slice(0, index)
              .reduce((sum, previous) => sum + previous.width + DIVIDER_WIDTH, 0);
          return (
            <Fragment key={pane.view.key}>
              <PaneDivider
                dividerHitLeft={Math.max(
                  1,
                  dividerX - Math.floor((DIVIDER_HIT_WIDTH - DIVIDER_WIDTH) / 2),
                )}
                dividerHitWidth={DIVIDER_HIT_WIDTH}
                isResizing={sidebarResize?.key === pane.view.key}
                theme={activeTheme}
                onMouseDown={beginSidebarResize(pane.view.key, "right", pane.width)}
                onMouseDrag={updateSidebarResize}
                onMouseDragEnd={endSidebarResize}
                onMouseUp={endSidebarResize}
              />
              {renderSidebarPane(pane)}
            </Fragment>
          );
        })}
      </box>

      {extensionToast ? (
        <ExtensionToast
          notification={extensionToast}
          terminalWidth={terminal.width}
          theme={activeTheme}
        />
      ) : null}

      {focusArea === "filter" ||
      Boolean(review.filter) ||
      Boolean(sessionNoticeText ?? transientNoticeText ?? noticeText) ? (
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

      {themeSelectorState.open ? (
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

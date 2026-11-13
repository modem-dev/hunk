/** @jsxImportSource react */
/**
 * The read-only browser review: toolbar, files sidebar, and the review stream.
 *
 * A terminal Hunk user should recognize it at once — the same regions and the same facts,
 * in the same themes — with web-native chrome. This component composes the page from the
 * running session (`../session/reviewSession.ts`): it subscribes to the mirror, the event
 * stream's connection state, and the local store, owns the per-browser view preferences and
 * theme, and routes the reader's actions to the store as page-local intents. It decides no
 * review semantics; those come from the store and the shared model.
 *
 * It also owns the page's commands (`../commands/`): the keyboard, the toolbar, and clicks
 * reach the same handlers, keyed by the shared catalog's ids. Hunk and file navigation and the
 * gap toggle lower through `lowerAppCommandToReviewIntent` and apply to the local store, so
 * `]` here and `]` in the terminal plan the same move; scrolling, layout, and theme are this
 * page's own.
 *
 * The session's shared state (`../mirror/sharedStateMirror.ts`) supplies what the page shows
 * beyond files: notes (adopted into the store by the session wiring), sidecar annotations,
 * agent marks, the shared filter, and the presentation defaults — title, theme, view options,
 * and the resolved keymap. This browser's own choices of theme and view options win over the
 * session's defaults and persist locally. An agent's reveal request (a token that only grows)
 * selects and reveals its target here; it is the one thing outside the page that moves it.
 * When the reader's scroll settles, the page reports where it is with a debounced
 * `selection/anchor` action, which a headless session turns into the focus `hunk session
 * context` reports; no other selection action is ever sent.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { selectActiveRevealNoteId } from "../../core/review/selectors";
import { reviewFileMatchesFilter } from "../../core/review/selectors";
import { lowerAppCommandToReviewIntent } from "../../core/run/commandCatalog";
import { formatKeyChord } from "../../core/run/keyChordLabels";
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import type { ReviewAgentRevealV1, ReviewThemeDefaultsV1 } from "../../session/reviewSharedState";
import { countVisibleNotesByFile } from "../notes/noteProjection";
import type { ReviewFileIndexEntry } from "../mirror/fileIndex";
import { defaultWebKeymap, webCommandChords, type WebKeymap } from "../commands/keyboard";
import { useWebKeyboard } from "../commands/useWebKeyboard";
import {
  buildWebCommands,
  type WebCommandHandlers,
  type WebCommandInvocation,
  type WebImplementedCommandId,
} from "../commands/webCommandTable";
import { reviewFailureMessage, type ReviewSession } from "../session/reviewSession";
import { FileSidebar } from "../sidebar/FileSidebar";
import { isLocalReviewIntent } from "../store/clientReviewStore";
import {
  ReviewStream,
  type ReviewRevealPoint,
  type ReviewStreamController,
} from "../stream/ReviewStream";
import {
  applyWebTheme,
  clearStoredThemeId,
  loadWebThemeIndex,
  readStoredThemeId,
  resolveSessionWebTheme,
  sessionCustomWebTheme,
  storeThemeId,
  type WebThemeIndexV1,
} from "../theme/themeIndex";
import {
  clampSidebarWidth,
  defaultSidebarOpen,
  readWebViewOverrides,
  resolveWebLayout,
  resolveWebViewPreferences,
  storeWebViewOverrides,
  type WebViewOverrides,
  type WebViewPreferences,
} from "../view/viewPreferences";
import { reviewHunkIndexForLine } from "../../core/review/geometry";
import { selectReviewNoteList } from "../../core/review/noteList";
import { Minimap } from "../minimap/Minimap";
import { readMinimapEnabled, storeMinimapEnabled } from "../minimap/minimapPreference";
import { NotesTab } from "../notesPanel/NotesTab";
import { OverviewTab } from "../overview/OverviewTab";
import { selectWebReviewOverview } from "../panel/overviewInput";
import { webLocalKeyCommands, withWebLocalChords } from "../panel/panelCommands";
import type { WebLocalCommandId } from "../commands/webLocalCommands";
import {
  readSidePanelPreferences,
  resolveSidePanelOpen,
  storeSidePanelPreferences,
  type SidePanelPreferences,
} from "../panel/panelPreferences";
import { SidePanel, type SidePanelTool } from "../panel/SidePanel";
import type { ThemeMenuOption } from "./ThemeMenu";
import { ToastRegion } from "../actions/toasts";
import { reviewLinkWithCapability } from "../session/capability";
import { ReviewControls } from "./ReviewControls";
import { Toolbar } from "./Toolbar";
import { useReviewInteraction } from "./useReviewInteraction";
import { useReviewTools } from "./useReviewTools";

/** Width of one monospace column on this page, measured once the fonts are in place. */
function useColumnWidth() {
  const [width, setWidth] = useState(8);
  useLayoutEffect(() => {
    const probe = document.createElement("span");
    probe.className = "column-probe";
    probe.textContent = "0".repeat(100);
    document.body.appendChild(probe);
    setWidth(probe.getBoundingClientRect().width / 100 || 8);
    probe.remove();
  }, []);
  return width;
}

/**
 * The width of an element, kept current as it resizes.
 *
 * A callback ref, so an element that mounts after the first render (the page shows a
 * connecting message first) is still observed.
 */
function useElementWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => setWidth(entries[0]!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

/** The theme-menu option that follows the session's theme instead of a stored choice. */
const SESSION_THEME_OPTION_ID = "hunk:session-theme";

/**
 * The theme index, the active theme, the menu's options, and a setter that remembers the
 * choice. This browser's stored choice wins; without one, the session's theme applies.
 */
function useWebTheme(sessionTheme: ReviewThemeDefaultsV1 | undefined) {
  const [index, setIndex] = useState<WebThemeIndexV1 | undefined>(undefined);
  const [themeId, setThemeId] = useState<string | undefined>(() => readStoredThemeId());
  useEffect(() => {
    void loadWebThemeIndex().then(setIndex);
  }, []);
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = index
    ? resolveSessionWebTheme(index, themeId, sessionTheme, prefersDark)
    : undefined;
  useLayoutEffect(() => {
    if (theme) applyWebTheme(document.documentElement, theme);
  }, [theme]);
  const choose = useCallback((id: string) => {
    if (id === SESSION_THEME_OPTION_ID) {
      setThemeId(undefined);
      clearStoredThemeId();
      return;
    }
    setThemeId(id);
    storeThemeId(id);
  }, []);
  const options = useMemo((): ThemeMenuOption[] => {
    const builtIn = index?.themes ?? [];
    if (!sessionTheme) return builtIn;
    const custom = sessionTheme.kind === "custom" ? sessionCustomWebTheme(sessionTheme) : undefined;
    const sessionLabel =
      custom?.label ?? builtIn.find((candidate) => candidate.id === sessionTheme.id)?.label;
    return [
      {
        id: SESSION_THEME_OPTION_ID,
        label: `Use session theme${sessionLabel ? ` (${sessionLabel})` : ""}`,
        appearance: sessionTheme.appearance,
      },
      ...(custom ? [custom] : []),
      ...builtIn,
    ];
  }, [index, sessionTheme]);
  const selectedId =
    themeId !== undefined && options.some((option) => option.id === themeId)
      ? themeId
      : sessionTheme
        ? SESSION_THEME_OPTION_ID
        : theme?.id;
  return { options, selectedId, theme, choose };
}

const NO_HIGHLIGHTS = {};

/** Below this viewport or stream width the minimap hides, leaving the room to the diff. */
const MINIMAP_MIN_VIEWPORT = 1000;
const MINIMAP_MIN_STREAM_WIDTH = 560;

/** The minimap's width, as the stylesheet sets it. */
const MINIMAP_WIDTH_PX = 44;

/** How long the viewport must stay put before the page reports its focus to the session. */
const FOCUS_REPORT_DEBOUNCE_MS = 400;

/** The page for one running session. */
export function ReviewApp({ session }: { session: ReviewSession }) {
  const mirror = useSyncExternalStore(session.mirror.subscribe, session.mirror.getSnapshot);
  const connection = useSyncExternalStore(session.connection.subscribe, session.connection.get);
  const review = useSyncExternalStore(
    session.review.store.subscribe,
    session.review.store.getSnapshot,
  );
  const sharedSnapshot = useSyncExternalStore(session.shared.subscribe, session.shared.getSnapshot);
  const sharedState = sharedSnapshot.body?.state;
  const presentation = sharedState?.presentation;
  // Notes and marks belong to the document they were resolved against.
  const shownShared =
    sharedState && sharedState.generation === mirror.address?.generation ? sharedState : undefined;
  const { options: themeOptions, selectedId, theme, choose } = useWebTheme(presentation?.theme);
  const [overrides, setOverrides] = useState<WebViewOverrides>(() => readWebViewOverrides());
  const preferences: WebViewPreferences = useMemo(
    () => resolveWebViewPreferences(overrides, presentation?.view),
    [overrides, presentation?.view],
  );
  const columnWidth = useColumnWidth();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const streamController = useRef<ReviewStreamController | null>(null);
  // The host's resolved keymap (`[keybindings]` folded in) once the shared state arrives; the
  // catalog's defaults until then.
  const keymap: WebKeymap = useMemo(() => {
    const resolved: Map<string, readonly string[]> = presentation
      ? new Map(Object.entries(presentation.keymap))
      : new Map(defaultWebKeymap());
    // The catalog ships the filter unbound (`/` is the terminal's content search); a page has
    // no content search of its own, so `/` focuses the filter here unless the host bound it.
    if ((resolved.get("hunk.review.focusFilter") ?? []).length === 0) {
      resolved.set("hunk.review.focusFilter", ["/"]);
    }
    return resolved;
  }, [presentation]);
  const keyHint = useCallback(
    (commandId: WebImplementedCommandId) => {
      const chords = webCommandChords(keymap, commandId);
      return chords.length > 0 ? chords.map(formatKeyChord).join(" / ") : undefined;
    },
    [keymap],
  );
  const [mainRef, mainWidth] = useElementWidth<HTMLDivElement>();

  // A change made here becomes this browser's override of that one option.
  const updatePreferences = useCallback((next: Partial<WebViewPreferences>) => {
    setOverrides((current) => {
      const merged = { ...current, ...next };
      storeWebViewOverrides(merged);
      return merged;
    });
  }, []);

  const sidebarOpen = preferences.sidebarOpen ?? defaultSidebarOpen(window.innerWidth, columnWidth);
  // The side panel's frame is this browser's; its tools are separate modules (`../panel/`).
  const [panel, setPanel] = useState<SidePanelPreferences>(() => readSidePanelPreferences());
  const updatePanel = useCallback((next: Partial<SidePanelPreferences>, store = true) => {
    setPanel((current) => {
      const merged = { ...current, ...next };
      if (store) storeSidePanelPreferences(merged);
      return merged;
    });
  }, []);
  const panelOpen = resolveSidePanelOpen(panel, window.innerWidth);
  const streamWidth = Math.max(
    0,
    mainWidth - (sidebarOpen ? preferences.sidebarWidth : 0) - (panelOpen ? panel.width : 0),
  );
  // The minimap hides when the stream is too narrow to spare it the room.
  // The reader may turn the minimap off (`hunk.web.toggleMinimap`); the choice is per browser.
  const [minimapEnabled, setMinimapEnabled] = useState(() => readMinimapEnabled());
  const showMinimap =
    minimapEnabled &&
    window.innerWidth >= MINIMAP_MIN_VIEWPORT &&
    streamWidth >= MINIMAP_MIN_STREAM_WIDTH;
  const layout = resolveWebLayout(
    preferences.layout,
    streamWidth - (showMinimap ? MINIMAP_WIDTH_PX : 0),
    columnWidth,
  );

  // The shared filter decides the visible stream, as it does in the terminal; the planner
  // reads the same filter from the store.
  const filter = shownShared?.filter ?? "";
  const visibleSlots = useMemo(
    () =>
      filter
        ? mirror.slots.filter((slot) => !slot.index || reviewFileMatchesFilter(slot.index, filter))
        : mirror.slots,
    [mirror.slots, filter],
  );
  const entries = useMemo(
    () => visibleSlots.flatMap((slot): ReviewFileIndexEntry[] => (slot.index ? [slot.index] : [])),
    [visibleSlots],
  );
  const sidecarNotes = useMemo(
    () => shownShared?.notes.filter((entry) => entry.origin === "sidecar") ?? [],
    [shownShared],
  );
  const noteCounts = useMemo(
    () =>
      countVisibleNotesByFile(
        {
          liveNotes: review.liveNotes,
          userNotes: review.userNotes,
          showAgentNotes: review.showAgentNotes,
        },
        sidecarNotes,
      ),
    [review.liveNotes, review.userNotes, review.showAgentNotes, sidecarNotes],
  );
  const totals = useMemo(
    () =>
      entries.reduce(
        (sum, entry) => ({
          additions: sum.additions + entry.stats.additions,
          deletions: sum.deletions + entry.stats.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [entries],
  );

  const overview = useMemo(
    () => (panelOpen ? selectWebReviewOverview(entries, shownShared) : undefined),
    [panelOpen, entries, shownShared],
  );

  // Report where the reader settled, so a headless session's `hunk session context` can say
  // where the reader is. Debounced; a failure is dropped, since the next settle reports again.
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(focusTimer.current), []);
  const reportFocus = useCallback(
    (fileKey: string, hunkIndex: number) => {
      clearTimeout(focusTimer.current);
      focusTimer.current = setTimeout(() => {
        // While a newer generation loads, the shown one is already out of date and the
        // session would refuse the report; the next settle after the swap reports instead.
        const shown = session.mirror.getSnapshot();
        const generation = shown.address?.generation;
        if (!generation || shown.updating) return;
        // Best effort: the next settle reports again, so a refusal is not worth a retry.
        void session.actions.send(
          { type: "selection/anchor", fileKey, hunkIndex },
          { stillMeaningful: () => false },
        );
      }, FOCUS_REPORT_DEBOUNCE_MS);
    },
    [session],
  );

  // The reader scrolled and the viewport settled here; adopt it without moving anything.
  const anchorToViewport = useCallback(
    (fileKey: string, hunkIndex: number) => {
      const { document, selection } = session.review.store.getSnapshot();
      if (!document.files.some((file) => file.key === fileKey)) return;
      reportFocus(fileKey, hunkIndex);
      if (selection.fileKey === fileKey && selection.hunkIndex === hunkIndex) return;
      session.review.apply({ type: "selection/anchor", fileKey, hunkIndex });
    },
    [session, reportFocus],
  );

  // An agent's reveal selects and shows its target once per token. The token in the first
  // shared state the page receives is history, not a request made to this page; any later one
  // is revealed, waiting for the document if it arrives before the page finished loading.
  const [revealPoint, setRevealPoint] = useState<ReviewRevealPoint | undefined>(undefined);
  const lastAgentReveal = useRef<number | undefined>(undefined);
  const agentReveal: ReviewAgentRevealV1 | null | undefined = shownShared?.agentReveal;
  const documentReady = review.document.files.length > 0;
  useEffect(() => {
    if (agentReveal === undefined) return;
    const token = agentReveal?.token ?? 0;
    if (lastAgentReveal.current === undefined) {
      lastAgentReveal.current = token;
      return;
    }
    if (!documentReady || !agentReveal || token <= lastAgentReveal.current) return;
    lastAgentReveal.current = token;
    const { document } = session.review.store.getSnapshot();
    if (!document.files.some((file) => file.key === agentReveal.fileKey)) return;
    setRevealPoint({
      fileKey: agentReveal.fileKey,
      ...(agentReveal.side !== undefined ? { side: agentReveal.side } : {}),
      ...(agentReveal.line !== undefined ? { line: agentReveal.line } : {}),
      ...(agentReveal.noteId !== undefined ? { noteId: agentReveal.noteId } : {}),
    });
    session.review.apply({
      type: "selection/select",
      fileKey: agentReveal.fileKey,
      hunkIndex: agentReveal.hunkIndex,
      reveal: { anchor: "hunk", scrollToNote: agentReveal.noteId !== undefined },
      ...(agentReveal.noteId !== undefined ? { activeNoteId: agentReveal.noteId } : {}),
    });
  }, [agentReveal, documentReady, session]);
  // A note the selection asks to show is where its hunk reveal lands, when nothing more exact
  // (an agent's line) is pending for that file.
  const noteToReveal = review.reveal.scrollToNote ? selectActiveRevealNoteId(review) : undefined;
  const streamRevealPoint: ReviewRevealPoint | undefined =
    revealPoint && revealPoint.fileKey === review.selection.fileKey
      ? revealPoint
      : noteToReveal && review.selection.fileKey
        ? { fileKey: review.selection.fileKey, noteId: noteToReveal }
        : undefined;
  // The Notes tab lists every visible note by the shared order; choosing one selects it here and
  // reveals its card, the way an agent's reveal does, and never reaches the session.
  const noteList = useMemo(
    () => (panelOpen && panel.tab === "notes" ? selectReviewNoteList(review, sidecarNotes) : []),
    [panelOpen, panel.tab, review, sidecarNotes],
  );
  const selectNote = useCallback(
    (
      thread: { fileKey: string; hunkIndex: number },
      entry: { note: { id: string }; stored: boolean },
    ) => {
      setRevealPoint({ fileKey: thread.fileKey, noteId: entry.note.id });
      session.review.apply({
        type: "selection/select",
        fileKey: thread.fileKey,
        hunkIndex: thread.hunkIndex,
        reveal: { anchor: "hunk", scrollToNote: true },
        ...(entry.stored ? { activeNoteId: entry.note.id } : {}),
      });
    },
    [session],
  );
  // The minimap's marks, by file key.
  const minimapFiles = useMemo(
    () => new Map(review.document.files.map((file) => [file.key, file] as const)),
    [review.document],
  );
  const minimapNotes = useMemo(() => {
    const byFile = new Map<string, number[]>();
    if (!showMinimap) return byFile;
    for (const file of selectReviewNoteList(review, sidecarNotes)) {
      byFile.set(
        file.fileKey,
        file.threads.map((thread) => thread.hunkIndex),
      );
    }
    return byFile;
  }, [showMinimap, review, sidecarNotes]);
  const minimapHighlights = useMemo(() => {
    const byFile = new Map<string, number[]>();
    for (const [fileKey, marks] of Object.entries(shownShared?.agentHighlights ?? {})) {
      const file = minimapFiles.get(fileKey);
      if (!file) continue;
      byFile.set(
        fileKey,
        marks.map((mark) => Math.max(0, reviewHunkIndexForLine(file.hunks, mark.side, mark.line))),
      );
    }
    return byFile;
  }, [shownShared, minimapFiles]);
  const minimapViewed = useMemo(
    () => new Set(Object.keys(shownShared?.viewedFiles ?? {})),
    [shownShared],
  );
  const minimapSelected = useMemo(
    () =>
      review.selection.fileKey
        ? { fileKey: review.selection.fileKey, hunkIndex: review.selection.hunkIndex }
        : undefined,
    [review.selection.fileKey, review.selection.hunkIndex],
  );

  // A click on a hunk selects it where it is; the viewport stays put.
  const selectHunk = useCallback(
    (fileKey: string, hunkIndex: number) => {
      session.review.apply({
        type: "selection/select",
        fileKey,
        hunkIndex,
        reveal: { anchor: "none", scrollToNote: false },
      });
    },
    [session],
  );
  const toggleGap = useCallback(
    (fileKey: string, gapId: string) => {
      session.review.apply({ type: "expansion/toggle", fileKey, gapId });
    },
    [session],
  );
  const collapseGaps = useCallback(
    (fileKey: string) => {
      for (const gap of session.review.store.getSnapshot().expandedGaps) {
        if (gap.fileKey === fileKey && gap.expanded) {
          session.review.apply({ type: "expansion/toggle", fileKey, gapId: gap.gapId });
        }
      }
    },
    [session],
  );

  // What the page does for each catalogued command it implements. Toggles read the current
  // preferences through a ref so the table is built once per session.
  const viewRef = useRef({ preferences, sidebarOpen, panelOpen });
  viewRef.current = { preferences, sidebarOpen, panelOpen };
  const interactive = useReviewInteraction(session, shownShared);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const filterRef = useRef<HTMLInputElement | null>(null);
  const composers = useSyncExternalStore(
    session.composers.subscribe,
    session.composers.getSnapshot,
  );
  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(
        reviewLinkWithCapability(window.location, session.capability),
      );
      return true;
    } catch {
      return false;
    }
  }, [session]);
  const commands = useMemo(() => {
    const semantic = ({ entry, count }: WebCommandInvocation) => {
      const intent = lowerAppCommandToReviewIntent(entry, {
        count,
        state: session.review.store.getSnapshot(),
      });
      if (intent && isLocalReviewIntent(intent)) session.review.apply(intent);
    };
    const stream = () => streamController.current;
    const handlers: WebCommandHandlers = {
      "hunk.review.previousHunk": semantic,
      "hunk.review.nextHunk": semantic,
      "hunk.review.previousFile": semantic,
      "hunk.review.nextFile": semantic,
      "hunk.review.toggleHunkGap": semantic,
      "hunk.review.previousAnnotatedHunk": semantic,
      "hunk.review.nextAnnotatedHunk": semantic,
      "hunk.review.previousAnnotatedFile": semantic,
      "hunk.review.nextAnnotatedFile": semantic,
      // Note navigation walks the shared note order through the planner's `note` scope; the
      // catalog declares only its direction.
      "hunk.review.previousNote": ({ entry, count }) =>
        session.review.apply({
          type: "selection/move",
          scope: "note",
          delta: (entry.verticalDirection ?? -1) * count,
        }),
      "hunk.review.nextNote": ({ entry, count }) =>
        session.review.apply({
          type: "selection/move",
          scope: "note",
          delta: (entry.verticalDirection ?? 1) * count,
        }),
      "hunk.review.jumpToTop": () => stream()?.scrollToEdge("top"),
      "hunk.review.jumpToBottom": () => stream()?.scrollToEdge("bottom"),
      "hunk.review.pageDown": () => stream()?.scroll(1, "page"),
      "hunk.review.pageUp": () => stream()?.scroll(-1, "page"),
      "hunk.review.halfPageDown": () => stream()?.scroll(1, "half"),
      "hunk.review.halfPageUp": () => stream()?.scroll(-1, "half"),
      "hunk.review.stepDown": () => stream()?.scroll(1, "step"),
      "hunk.review.stepUp": () => stream()?.scroll(-1, "step"),
      "hunk.review.scrollCodeLeft": ({ shift }) => stream()?.scrollCode(-1, shift),
      "hunk.review.scrollCodeRight": ({ shift }) => stream()?.scrollCode(1, shift),
      "hunk.view.layoutSplit": () => updatePreferences({ layout: "split" }),
      "hunk.view.layoutUnified": () => updatePreferences({ layout: "unified" }),
      "hunk.view.layoutAuto": () => updatePreferences({ layout: "auto" }),
      "hunk.view.toggleFilesPane": () =>
        updatePreferences({ sidebarOpen: !viewRef.current.sidebarOpen }),
      "hunk.view.toggleLineNumbers": () =>
        updatePreferences({ showLineNumbers: !viewRef.current.preferences.showLineNumbers }),
      "hunk.view.toggleLineWrap": () =>
        updatePreferences({ wrapLines: !viewRef.current.preferences.wrapLines }),
      "hunk.view.openThemeSelector": () => setThemeMenuOpen(true),
      // Writing: notes, the shared toggles, and refresh (`./useReviewInteraction.tsx`).
      "hunk.review.startNote": () => interactiveRef.current.openOnSelection(),
      "hunk.review.editActiveNote": ({ entry }) => interactiveRef.current.noteCommand(entry),
      "hunk.review.replyToActiveNote": ({ entry }) => interactiveRef.current.noteCommand(entry),
      "hunk.review.deleteActiveNote": ({ entry }) => interactiveRef.current.noteCommand(entry),
      "hunk.review.saveNote": () => interactiveRef.current.saveFocused(),
      "hunk.view.toggleAgentNotes": () => void interactiveRef.current.toggleAgentNotes(),
      "hunk.review.focusFilter": () => filterRef.current?.focus(),
      "hunk.app.refresh": () => void interactiveRef.current.refresh(),
      // Finding: help (`./useReviewTools.tsx`, with the palette and go-to-file).
      "hunk.app.toggleHelp": () => toolsRef.current?.toggleHelp(),
    };
    return buildWebCommands(handlers);
  }, [session, updatePreferences]);
  // Page commands with plain chords (`hunk.web.*`, declared in `webLocalCommands.ts`) join the
  // catalogued ones on the keyboard; the palette and help list them from the same declaration.
  const panelHandlers = useMemo(
    (): Partial<Record<WebLocalCommandId, () => void>> => ({
      "hunk.web.toggleSidePanel": () => updatePanel({ open: !viewRef.current.panelOpen }),
      "hunk.web.showOverview": () => updatePanel({ open: true, tab: "overview" }),
      "hunk.web.showNotes": () => updatePanel({ open: true, tab: "notes" }),
      "hunk.web.toggleMinimap": () =>
        setMinimapEnabled((current) => {
          storeMinimapEnabled(!current);
          return !current;
        }),
    }),
    [updatePanel],
  );
  const pageCommands = useMemo(
    () => [...commands, ...webLocalKeyCommands((id) => panelHandlers[id]?.())],
    [commands, panelHandlers],
  );
  const pageKeymap = useMemo(() => withWebLocalChords(keymap), [keymap]);
  useWebKeyboard(pageCommands, pageKeymap);
  const tools = useReviewTools({
    session,
    commands,
    keymap,
    entries,
    documentReady,
    setRevealPoint,
    copyReviewLink: copyLink,
    chooseSessionTheme: () => choose(SESSION_THEME_OPTION_ID),
    setSidebarMode: (sidebarMode) => updatePreferences({ sidebarMode }),
    localHandlers: panelHandlers,
  });
  const toolsRef = useRef<typeof tools | undefined>(undefined);
  toolsRef.current = tools;
  const panelHint = webCommandChords(pageKeymap, "hunk.web.toggleSidePanel")
    .map(formatKeyChord)
    .join(" / ");
  const panelTools: SidePanelTool[] = overview
    ? [
        {
          id: "overview",
          label: "Overview",
          render: () => <OverviewTab overview={overview} onSelectFile={tools.jumpToFile} />,
        },
        {
          id: "notes",
          label: "Notes",
          render: () => (
            <NotesTab
              files={noteList}
              activeNoteId={review.activeNoteId}
              agentNotesHidden={!review.showAgentNotes}
              onSelectNote={selectNote}
            />
          ),
        },
      ]
    : [];

  // Dragging the divider resizes the sidebar; the width is stored when the drag ends.
  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const startX = event.clientX;
      const startWidth = preferences.sidebarWidth;
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent) =>
        setOverrides((current) => ({
          ...current,
          sidebarWidth: clampSidebarWidth(startWidth + moveEvent.clientX - startX),
        }));
      const end = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", end);
        setOverrides((current) => {
          storeWebViewOverrides(current);
          return current;
        });
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", end);
    },
    [preferences.sidebarWidth],
  );

  if (connection.kind === "ended" && connection.reason === "refused") {
    return (
      <p className="status page-message" data-state="failed" role="alert">
        {reviewErrorMessage(connection.code === "unauthorized" ? "unauthorized" : "no-publication")}
      </p>
    );
  }
  if (mirror.status === "failed") {
    return (
      <p className="status page-message" data-state="failed" role="alert">
        {reviewFailureMessage(mirror.error)}
      </p>
    );
  }
  if (mirror.status === "waiting") {
    return (
      <p className="status page-message" data-state="loading" role="status">
        Connecting to the Hunk session…
      </p>
    );
  }

  const status =
    connection.kind === "reconnecting"
      ? ({ label: "Reconnecting…", state: "reconnecting" } as const)
      : connection.kind === "ended"
        ? ({ label: "Session ended", state: "failed" } as const)
        : mirror.updating
          ? ({ label: "Updating…", state: "loading" } as const)
          : ({ label: "Connected", state: "connected" } as const);

  return (
    <div
      className="review-app"
      data-layout={layout}
      data-generation={mirror.address?.generation}
      style={
        {
          "--sidebar-width": `${preferences.sidebarWidth}px`,
          "--side-panel-width": `${panel.width}px`,
        } as CSSProperties
      }
    >
      <Toolbar
        title={presentation?.title || "Hunk review"}
        {...(presentation?.sourceLabel ? { sourceLabel: presentation.sourceLabel } : {})}
        {...(filter ? { filter } : {})}
        {...(shownShared?.omittedSidecarNotes
          ? { omittedNotes: shownShared.omittedSidecarNotes }
          : {})}
        fileCount={entries.length || mirror.totalFiles}
        additions={totals.additions}
        deletions={totals.deletions}
        status={status}
        progress={
          mirror.status === "loading"
            ? `Loading ${mirror.loadedFiles} of ${mirror.totalFiles}`
            : undefined
        }
        preferences={preferences}
        sidebarOpen={sidebarOpen}
        resolvedLayout={layout}
        themes={themeOptions}
        themeId={selectedId}
        {...(theme ? { themeLabel: theme.label } : {})}
        themeMenuOpen={themeMenuOpen}
        onThemeMenuOpen={setThemeMenuOpen}
        keyHint={keyHint}
        onPreferences={updatePreferences}
        onToggleSidebar={() => updatePreferences({ sidebarOpen: !sidebarOpen })}
        onTheme={choose}
        controls={
          <ReviewControls
            ref={filterRef}
            filterText={interactive.filterText}
            onFilterChange={interactive.changeFilter}
            {...(keyHint("hunk.review.focusFilter")
              ? { filterKeyHint: keyHint("hunk.review.focusFilter") }
              : {})}
            refreshing={interactive.refreshing}
            onRefresh={() => void interactive.refresh()}
            {...(keyHint("hunk.app.refresh")
              ? { refreshKeyHint: keyHint("hunk.app.refresh") }
              : {})}
            onCopyLink={copyLink}
          />
        }
        panelOpen={panelOpen}
        {...(panelHint ? { panelHint } : {})}
        onTogglePanel={() => updatePanel({ open: !panelOpen })}
      />
      <div className="review-main" ref={mainRef}>
        {sidebarOpen ? (
          <>
            <nav className="sidebar" aria-label="Files sidebar">
              <div className="sidebar-header">
                <span>Files</span>
                <div className="segmented small" role="radiogroup" aria-label="Sidebar mode">
                  {(["tree", "flat"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={preferences.sidebarMode === mode}
                      onClick={() => updatePreferences({ sidebarMode: mode })}
                    >
                      {mode === "tree" ? "Tree" : "Flat"}
                    </button>
                  ))}
                </div>
              </div>
              <FileSidebar
                entries={entries}
                noteCounts={noteCounts}
                selectedKey={review.selection.fileKey}
                mode={preferences.sidebarMode}
                onSelectFile={tools.jumpToFile}
              />
            </nav>
            <div
              className="sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize files sidebar"
              onPointerDown={startResize}
            />
          </>
        ) : null}
        <ReviewStream
          slots={visibleSlots}
          review={review}
          layout={layout}
          wrapLines={preferences.wrapLines}
          showLineNumbers={preferences.showLineNumbers}
          syntaxTheme={theme?.syntaxTheme ?? "github-dark-default"}
          appearance={theme?.appearance ?? "dark"}
          onToggleGap={toggleGap}
          onCollapseGaps={collapseGaps}
          onSelectHunk={selectHunk}
          onViewportAnchor={anchorToViewport}
          controller={streamController}
          columnWidth={columnWidth}
          generation={mirror.address?.generation}
          sidecarNotes={sidecarNotes}
          highlights={shownShared?.agentHighlights ?? NO_HIGHLIGHTS}
          {...(streamRevealPoint ? { revealPoint: streamRevealPoint } : {})}
          composers={composers}
          interaction={interactive.interaction}
        />
        {showMinimap ? (
          <Minimap
            slots={visibleSlots}
            files={minimapFiles}
            layout={layout}
            noteHunks={minimapNotes}
            highlightHunks={minimapHighlights}
            viewed={minimapViewed}
            {...(minimapSelected ? { selected: minimapSelected } : {})}
            controller={streamController}
            themeKey={theme?.id}
          />
        ) : null}
        {panelOpen && panelTools.length > 0 ? (
          <SidePanel
            tools={panelTools}
            tab={panel.tab}
            width={panel.width}
            onTab={(tab) => updatePanel({ tab })}
            onWidth={(width, commit) => updatePanel({ width }, commit)}
            onClose={() => updatePanel({ open: false })}
            {...(panelHint ? { closeHint: panelHint } : {})}
          />
        ) : null}
      </div>
      <ToastRegion toasts={session.toasts} />
      {tools.overlay}
    </div>
  );
}

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
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../session/reviewProtocol";
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
import type { ThemeMenuOption } from "./ThemeMenu";
import { Toolbar } from "./Toolbar";

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

/** The width of an element, kept current as it resizes. */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => setWidth(entries[0]!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
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

/** A per-tab client identity for actions; never stored, so each tab is its own actor. */
function randomClientId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `browser-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

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
  const keymap: WebKeymap = useMemo(
    () => (presentation ? new Map(Object.entries(presentation.keymap)) : defaultWebKeymap()),
    [presentation],
  );
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
  const streamWidth = Math.max(0, mainWidth - (sidebarOpen ? preferences.sidebarWidth : 0));
  const layout = resolveWebLayout(preferences.layout, streamWidth, columnWidth);

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

  const selectFile = useCallback(
    (fileKey: string) => {
      if (!session.review.store.getSnapshot().document.files.some((file) => file.key === fileKey))
        return;
      session.review.apply({
        type: "selection/select-file",
        fileKey,
        reveal: { anchor: "file-top", scrollToNote: false },
      });
    },
    [session],
  );
  // Report where the reader settled, so a headless session's `hunk session context` can say
  // where the reader is. Debounced; a failure is dropped, since the next settle reports again.
  const clientId = useMemo(() => randomClientId(), []);
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
        void session.client
          .postAction({
            protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
            generation,
            actor: { clientId, kind: "browser" },
            action: { type: "selection/anchor", fileKey, hunkIndex },
          })
          .catch(() => undefined);
      }, FOCUS_REPORT_DEBOUNCE_MS);
    },
    [session, clientId],
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

  // An agent's reveal selects and shows its target once per token. The token the page first
  // sees is history, not a request made to this page.
  const [revealPoint, setRevealPoint] = useState<ReviewRevealPoint | undefined>(undefined);
  const lastAgentReveal = useRef<number | undefined>(undefined);
  const agentReveal: ReviewAgentRevealV1 | null | undefined = shownShared?.agentReveal;
  const documentReady = review.document.files.length > 0;
  useEffect(() => {
    if (!documentReady || agentReveal === undefined) return;
    const token = agentReveal?.token ?? 0;
    if (lastAgentReveal.current === undefined) {
      lastAgentReveal.current = token;
      return;
    }
    if (!agentReveal || token <= lastAgentReveal.current) return;
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
  const viewRef = useRef({ preferences, sidebarOpen });
  viewRef.current = { preferences, sidebarOpen };
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
    };
    return buildWebCommands(handlers);
  }, [session, updatePreferences]);
  useWebKeyboard(commands, keymap);

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
      style={{ "--sidebar-width": `${preferences.sidebarWidth}px` } as CSSProperties}
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
                onSelectFile={selectFile}
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
        />
      </div>
    </div>
  );
}

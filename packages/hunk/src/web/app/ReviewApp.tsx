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
import { lowerAppCommandToReviewIntent } from "../../core/run/commandCatalog";
import { formatKeyChord } from "../../core/run/keyChordLabels";
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import type { ReviewFileIndexEntry } from "../mirror/fileIndex";
import { defaultWebKeymap, webCommandChords } from "../commands/keyboard";
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
import { ReviewStream, type ReviewStreamController } from "../stream/ReviewStream";
import {
  applyWebTheme,
  loadWebThemeIndex,
  readStoredThemeId,
  resolveWebTheme,
  storeThemeId,
  type WebThemeIndexV1,
} from "../theme/themeIndex";
import {
  clampSidebarWidth,
  defaultSidebarOpen,
  readWebViewPreferences,
  resolveWebLayout,
  storeWebViewPreferences,
  type WebViewPreferences,
} from "../view/viewPreferences";
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

/** The theme index, the active theme, and a setter that remembers the choice. */
function useWebTheme() {
  const [index, setIndex] = useState<WebThemeIndexV1 | undefined>(undefined);
  const [themeId, setThemeId] = useState<string | undefined>(() => readStoredThemeId());
  useEffect(() => {
    void loadWebThemeIndex().then(setIndex);
  }, []);
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = index ? resolveWebTheme(index, themeId, prefersDark) : undefined;
  useLayoutEffect(() => {
    if (theme) applyWebTheme(document.documentElement, theme);
  }, [theme]);
  const choose = useCallback((id: string) => {
    setThemeId(id);
    storeThemeId(id);
  }, []);
  return { themes: index?.themes ?? [], theme, choose };
}

/** The page for one running session. */
export function ReviewApp({ session }: { session: ReviewSession }) {
  const mirror = useSyncExternalStore(session.mirror.subscribe, session.mirror.getSnapshot);
  const connection = useSyncExternalStore(session.connection.subscribe, session.connection.get);
  const review = useSyncExternalStore(
    session.review.store.subscribe,
    session.review.store.getSnapshot,
  );
  const { themes, theme, choose } = useWebTheme();
  const [preferences, setPreferences] = useState<WebViewPreferences>(() =>
    readWebViewPreferences(),
  );
  const columnWidth = useColumnWidth();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const streamController = useRef<ReviewStreamController | null>(null);
  // The catalog's defaults until the state route delivers the host's resolved keymap.
  const keymap = useMemo(() => defaultWebKeymap(), []);
  const keyHint = useCallback(
    (commandId: WebImplementedCommandId) => {
      const chords = webCommandChords(keymap, commandId);
      return chords.length > 0 ? chords.map(formatKeyChord).join(" / ") : undefined;
    },
    [keymap],
  );
  const [mainRef, mainWidth] = useElementWidth<HTMLDivElement>();

  const updatePreferences = useCallback((next: Partial<WebViewPreferences>) => {
    setPreferences((current) => {
      const merged = { ...current, ...next };
      storeWebViewPreferences(merged);
      return merged;
    });
  }, []);

  const sidebarOpen = preferences.sidebarOpen ?? defaultSidebarOpen(window.innerWidth, columnWidth);
  const streamWidth = Math.max(0, mainWidth - (sidebarOpen ? preferences.sidebarWidth : 0));
  const layout = resolveWebLayout(preferences.layout, streamWidth, columnWidth);

  const entries = useMemo(
    () => mirror.slots.flatMap((slot): ReviewFileIndexEntry[] => (slot.index ? [slot.index] : [])),
    [mirror.slots],
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
  // The reader scrolled and the viewport settled here; adopt it without moving anything.
  const anchorToViewport = useCallback(
    (fileKey: string, hunkIndex: number) => {
      const { document, selection } = session.review.store.getSnapshot();
      if (selection.fileKey === fileKey && selection.hunkIndex === hunkIndex) return;
      if (!document.files.some((file) => file.key === fileKey)) return;
      session.review.apply({ type: "selection/anchor", fileKey, hunkIndex });
    },
    [session],
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
        setPreferences((current) => ({
          ...current,
          sidebarWidth: clampSidebarWidth(startWidth + moveEvent.clientX - startX),
        }));
      const end = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", end);
        setPreferences((current) => {
          storeWebViewPreferences(current);
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
        title="Hunk review"
        fileCount={mirror.totalFiles}
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
        themes={themes}
        themeId={theme?.id}
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
          slots={mirror.slots}
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
        />
      </div>
    </div>
  );
}

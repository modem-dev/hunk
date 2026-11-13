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
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import type { ReviewFileIndexEntry } from "../mirror/fileIndex";
import { reviewFailureMessage, type ReviewSession } from "../session/reviewSession";
import { FileSidebar } from "../sidebar/FileSidebar";
import { ReviewStream } from "../stream/ReviewStream";
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
  const anchorFile = useCallback(
    (fileKey: string) => {
      if (!session.review.store.getSnapshot().document.files.some((file) => file.key === fileKey))
        return;
      session.review.apply({ type: "selection/anchor", fileKey, hunkIndex: 0 });
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
          onTopFileChange={anchorFile}
          generation={mirror.address?.generation}
        />
      </div>
    </div>
  );
}

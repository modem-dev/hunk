/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserReviewApiClient } from "./lib/apiClient";
import { ReviewSnapshotMirror, type ReviewMirrorEvent } from "./lib/mirror";
import { projectVisibleBrowserReview } from "./lib/reviewProjection";
import { hunkThemeCssVariables, useHunkWebTheme } from "./lib/theme";
import { createReviewTreeSource, ReviewFileTree } from "./lib/treeSource";
import type { BrowserConnectionState, BrowserReviewSnapshot } from "./lib/reviewTypes";
import { fileAnchorId, ReviewStream } from "./components/ReviewStream";

export interface WebReviewAppProps {
  api: BrowserReviewApiClient;
  initialSnapshot: BrowserReviewSnapshot;
}

/** Coordinate the read-only broker mirror, continuous stream, and local tree navigation. */
export function WebReviewApp({ api, initialSnapshot }: WebReviewAppProps) {
  const mirrorRef = useRef(new ReviewSnapshotMirror());
  if (!mirrorRef.current.getSnapshot())
    mirrorRef.current.apply({ type: "snapshot", data: initialSnapshot });
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const activeApiGeneration = useRef<string | undefined>(undefined);
  // Descendant effects may request resources immediately after this render. Activate the
  // generation first so replacement aborts can never reject the new document's reads.
  if (activeApiGeneration.current !== snapshot.generation) {
    api.replaceGeneration(snapshot.generation);
    activeApiGeneration.current = snapshot.generation;
  }
  const visible = useMemo(
    () => projectVisibleBrowserReview(snapshot.manifest, snapshot.state),
    [snapshot],
  );
  const theme = useHunkWebTheme();
  const [connection, setConnection] = useState<BrowserConnectionState>("connecting");
  const [selectedFileKey, setSelectedFileKey] = useState<string | undefined>(() =>
    validSelection(
      initialSnapshot,
      projectVisibleBrowserReview(initialSnapshot.manifest, initialSnapshot.state).files,
    ),
  );
  const stopEvents = useRef<(() => void) | undefined>(undefined);
  const recovery = useRef<Promise<void> | undefined>(undefined);
  const treeGeneration = useRef(initialSnapshot.generation);

  const revealFile = useCallback((fileKey: string, focus: boolean) => {
    const target = globalThis.document?.getElementById(fileAnchorId(fileKey));
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (focus && target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }, []);

  const [treeSource] = useState(() => {
    const initialVisible = projectVisibleBrowserReview(
      initialSnapshot.manifest,
      initialSnapshot.state,
    );
    return createReviewTreeSource(
      initialVisible.document,
      initialVisible.mutableNotes,
      (fileKey) => {
        setSelectedFileKey(fileKey);
        revealFile(fileKey, true);
      },
    );
  });

  const recoverSnapshot = useCallback(() => {
    if (recovery.current) return recovery.current;
    recovery.current = api
      .snapshot()
      .then((complete) => {
        const result = mirrorRef.current.apply({ type: "snapshot", data: complete });
        if (result.kind === "accepted" && result.snapshot) setSnapshot(result.snapshot);
        setConnection("connected");
      })
      .catch((error: { status?: number }) => {
        setConnection(error.status === 401 ? "expired" : "disconnected");
      })
      .finally(() => {
        recovery.current = undefined;
      });
    return recovery.current;
  }, [api]);

  const onMirrorEvent = useCallback(
    async (event: ReviewMirrorEvent) => {
      const result = mirrorRef.current.apply(event);
      if (result.kind === "disconnect") {
        setConnection("disconnected");
        stopEvents.current?.();
      } else if (result.kind === "gap") {
        setConnection("reconnecting");
        await recoverSnapshot();
      } else if (result.kind === "accepted" && result.snapshot) {
        setSnapshot(result.snapshot);
        setConnection("connected");
      }
    },
    [recoverSnapshot],
  );

  useEffect(() => {
    stopEvents.current = api.events({
      onEvent: onMirrorEvent,
      onMalformed: async () => {
        setConnection("reconnecting");
        await recoverSnapshot();
      },
      onOpen: () => setConnection("connected"),
      onError: (status) => {
        if (status === 401) setConnection("expired");
        else if (status === 404) setConnection("disconnected");
        else setConnection("reconnecting");
      },
    });
    return () => stopEvents.current?.();
  }, [api, onMirrorEvent, recoverSnapshot]);

  useEffect(() => {
    const sharedSelection = validSelection(snapshot, visible.files);
    const replacingGeneration = treeGeneration.current !== snapshot.generation;
    treeGeneration.current = snapshot.generation;
    const retained = treeSource.reset(
      visible.document,
      visible.mutableNotes,
      sharedSelection ?? selectedFileKey,
    );
    if (replacingGeneration || sharedSelection) {
      setSelectedFileKey(retained);
      if (sharedSelection) revealFile(sharedSelection, false);
    }
  }, [snapshot, visible, treeSource, revealFile]);

  const onVisibleFile = useCallback(
    (fileKey: string) => {
      setSelectedFileKey(fileKey);
      treeSource.selectFile(fileKey);
    },
    [treeSource],
  );

  return (
    <div
      className="web-review"
      data-connection={connection}
      data-theme={theme.type}
      style={hunkThemeCssVariables(theme)}
    >
      <header className="topbar">
        <div>
          <span className="wordmark">Hunk</span>
          <span className="topbar__source">{snapshot.manifest.sourceLabel}</span>
        </div>
        <ConnectionStatus state={connection} />
      </header>
      <aside className="sidebar">
        <div className="review-summary">
          <h1>{snapshot.manifest.title}</h1>
          {snapshot.manifest.summary ? <p>{snapshot.manifest.summary}</p> : null}
          {snapshot.manifest.agentSummary ? <p>{snapshot.manifest.agentSummary}</p> : null}
          <span>
            {visible.files.length} of {snapshot.manifest.files.length} changed files
          </span>
          {snapshot.state.filter ? <span>Filter: {snapshot.state.filter}</span> : null}
        </div>
        <div className="sidebar__tree">
          <ReviewFileTree source={treeSource} theme={theme} />
        </div>
      </aside>
      <main className="review-main" aria-label="Continuous code review">
        <ReviewStream
          api={api}
          document={visible.document}
          mutableNotes={visible.mutableNotes}
          onVisibleFile={onVisibleFile}
          selectedFileKey={selectedFileKey}
          theme={theme}
        />
      </main>
      {connection === "expired" || connection === "disconnected" ? (
        <div className="connection-banner" role="alert">
          <strong>
            {connection === "expired" ? "Review link expired" : "Review disconnected"}
          </strong>
          <span>
            {connection === "expired"
              ? "Reopen the local review link to authenticate again."
              : "The owning Hunk process is no longer connected. The last complete snapshot remains read-only."}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function validSelection(
  snapshot: BrowserReviewSnapshot,
  files: readonly { key: string }[],
): string | undefined {
  const key = snapshot.state.selection.fileKey;
  return typeof key === "string" && files.some((file) => file.key === key) ? key : files[0]?.key;
}

function ConnectionStatus({ state }: { state: BrowserConnectionState }) {
  const labels: Record<BrowserConnectionState, string> = {
    connecting: "Connecting…",
    connected: "Live · read-only",
    reconnecting: "Reconnecting…",
    disconnected: "Disconnected",
    expired: "Expired",
  };
  return <span className={`connection connection--${state}`}>{labels[state]}</span>;
}

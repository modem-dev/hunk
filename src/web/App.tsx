/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HunkReviewActionV1 } from "../session/reviewProtocol";
import {
  BrowserReviewApiError,
  BrowserReviewConflictError,
  type BrowserReviewApiClient,
} from "./lib/apiClient";
import { ReviewSnapshotMirror, type ReviewMirrorEvent } from "./lib/mirror";
import { projectVisibleBrowserReview } from "./lib/reviewProjection";
import { hunkThemeCssVariables, useHunkWebTheme } from "./lib/theme";
import { createReviewTreeSource, ReviewFileTree } from "./lib/treeSource";
import type { BrowserConnectionState, BrowserReviewSnapshot } from "./lib/reviewTypes";
import { fileAnchorId, ReviewStream } from "./components/ReviewStream";

const EMPTY_EXPANDED_GAPS = [] as const;
const EMPTY_SOURCE_STATUSES = {} as const;

export interface WebReviewAppProps {
  api: BrowserReviewApiClient;
  initialSnapshot: BrowserReviewSnapshot;
}

/** Coordinate the live broker mirror, semantic mutations, and local tree navigation. */
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
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [sharedFilter, setSharedFilter] = useState(initialSnapshot.state.filter);
  const [composerBody, setComposerBody] = useState("");
  const [selectedFileKey, setSelectedFileKey] = useState<string | undefined>(() =>
    validSelection(
      initialSnapshot,
      projectVisibleBrowserReview(initialSnapshot.manifest, initialSnapshot.state).files,
    ),
  );
  const stopEvents = useRef<(() => void) | undefined>(undefined);
  const recovery = useRef<Promise<boolean> | undefined>(undefined);
  const reconnectNeedsSnapshot = useRef(false);
  const completeSnapshotToken = useRef(0);
  const latestAcceptedComplete = useRef<
    { token: number; snapshot: BrowserReviewSnapshot } | undefined
  >(undefined);
  const mutationsAvailable = useRef(false);
  const treeGeneration = useRef(initialSnapshot.generation);
  const pendingRevealFile = useRef<string | undefined>(undefined);
  const dispatchActionRef = useRef<
    ((action: HunkReviewActionV1, expectedRevision?: number) => Promise<boolean>) | null
  >(null);

  const revealFile = useCallback((fileKey: string, focus: boolean) => {
    const target = globalThis.document?.getElementById(fileAnchorId(fileKey));
    // Large reviews window most file bodies; jump directly so a distant reveal does not animate
    // through a long run of intentional spacers before the target resource mounts.
    target?.scrollIntoView({ block: "start", behavior: "auto" });
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
        void dispatchActionRef.current?.({
          type: "selection/select",
          selection: { fileKey, hunkIndex: 0 },
          reveal: { kind: "file-top" },
        });
      },
    );
  });

  const recoverSnapshot = useCallback(() => {
    mutationsAvailable.current = false;
    reconnectNeedsSnapshot.current = true;
    setConnection("reconnecting");
    if (recovery.current) return recovery.current;
    const startingCompleteToken = completeSnapshotToken.current;
    const recover = async () => {
      let staleAttempts = 0;
      while (reconnectNeedsSnapshot.current) {
        const complete = await api.snapshot();
        const result = mirrorRef.current.apply({ type: "snapshot", data: complete });
        if (result.kind === "accepted" && result.snapshot) {
          setSnapshot(result.snapshot);
          reconnectNeedsSnapshot.current = false;
          mutationsAvailable.current = true;
          setConnection("connected");
          return true;
        }
        const current = mirrorRef.current.getSnapshot();
        const acceptedComplete = latestAcceptedComplete.current;
        const currentCoversFetchedSnapshot =
          result.kind === "stale" &&
          current?.generation === complete.generation &&
          current.state.stateRevision >= complete.state.stateRevision;
        const newerCompleteArrivedDuringRecovery =
          result.kind === "stale" &&
          current &&
          acceptedComplete &&
          acceptedComplete.token > startingCompleteToken &&
          current.generation === acceptedComplete.snapshot.generation &&
          current.state.stateRevision >= acceptedComplete.snapshot.state.stateRevision &&
          (complete.generation !== acceptedComplete.snapshot.generation ||
            acceptedComplete.snapshot.state.stateRevision >= complete.state.stateRevision);
        if (current && (currentCoversFetchedSnapshot || newerCompleteArrivedDuringRecovery)) {
          setSnapshot(current);
          reconnectNeedsSnapshot.current = false;
          mutationsAvailable.current = true;
          setConnection("connected");
          return true;
        }
        reconnectNeedsSnapshot.current = true;
        setConnection("reconnecting");
        if (result.kind !== "stale") return false;
        staleAttempts += 1;
        // The first stale response retries immediately; repeated equality waits briefly to avoid a spin.
        if (staleAttempts > 1) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    const task = recover()
      .catch((error: { status?: number }) => {
        reconnectNeedsSnapshot.current = true;
        mutationsAvailable.current = false;
        setConnection(error.status === 401 ? "expired" : "reconnecting");
        return false;
      })
      .finally(() => {
        if (recovery.current === task) recovery.current = undefined;
      });
    recovery.current = task;
    return task;
  }, [api]);

  /** Confirm one authoritative action result before adopting durable browser state. */
  const dispatchAction = useCallback(
    async (action: HunkReviewActionV1, expectedRevision?: number) => {
      if (!mutationsAvailable.current) {
        setActionMessage("Mutations are disabled until the live review reconnects.");
        return false;
      }
      setActionMessage(null);
      const current = mirrorRef.current.getSnapshot();
      if (!current) return false;
      try {
        const result = await api.action(
          current.generation,
          expectedRevision ?? current.state.stateRevision,
          action,
        );
        if (result.generation !== current.generation) {
          return recoverSnapshot();
        }
        const accepted = mirrorRef.current.apply({
          type: "state",
          data: { generation: result.generation, state: result.state },
        });
        if (accepted.kind === "accepted" && accepted.snapshot) {
          setSnapshot(accepted.snapshot);
        } else if (accepted.kind === "gap") {
          return recoverSnapshot();
        }
        return true;
      } catch (error) {
        if (error instanceof BrowserReviewConflictError) {
          setActionMessage("Review changed; refreshed the latest state. Retry your action.");
          await recoverSnapshot();
        } else {
          setActionMessage(
            error instanceof BrowserReviewApiError
              ? error.message
              : "The review action could not be applied.",
          );
        }
        return false;
      }
    },
    [api, recoverSnapshot],
  );

  dispatchActionRef.current = dispatchAction;

  const onMirrorEvent = useCallback(
    async (event: ReviewMirrorEvent) => {
      const result = mirrorRef.current.apply(event);
      if (result.kind === "disconnect") {
        mutationsAvailable.current = false;
        setConnection("disconnected");
        stopEvents.current?.();
      } else if (result.kind === "gap") {
        mutationsAvailable.current = false;
        reconnectNeedsSnapshot.current = true;
        setConnection("reconnecting");
        await recoverSnapshot();
      } else if (result.kind === "accepted" && result.snapshot) {
        setSnapshot(result.snapshot);
        if (event.type === "snapshot" || event.type === "document") {
          completeSnapshotToken.current += 1;
          latestAcceptedComplete.current = {
            token: completeSnapshotToken.current,
            snapshot: result.snapshot,
          };
        }
        if (reconnectNeedsSnapshot.current || recovery.current) {
          await recoverSnapshot();
        } else {
          mutationsAvailable.current = true;
          setConnection("connected");
        }
      }
    },
    [recoverSnapshot],
  );

  useEffect(() => {
    stopEvents.current = api.events({
      onEvent: onMirrorEvent,
      onMalformed: async () => {
        mutationsAvailable.current = false;
        reconnectNeedsSnapshot.current = true;
        setConnection("reconnecting");
        await recoverSnapshot();
      },
      onOpen: () => {
        if (reconnectNeedsSnapshot.current) {
          void recoverSnapshot();
        } else {
          mutationsAvailable.current = true;
          setConnection("connected");
        }
      },
      onError: (status) => {
        // This ref closes the mutation gate synchronously, before React commits connection UI.
        mutationsAvailable.current = false;
        reconnectNeedsSnapshot.current = true;
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
    setSharedFilter(snapshot.state.filter);
    if (replacingGeneration || sharedSelection) setSelectedFileKey(retained);
    if (sharedSelection) treeSource.selectFile(sharedSelection);
  }, [snapshot, visible, treeSource]);

  useEffect(() => {
    const sharedSelection = validSelection(snapshot, visible.files);
    if (!sharedSelection) return;
    pendingRevealFile.current = sharedSelection;
    setSelectedFileKey(sharedSelection);
    treeSource.selectFile(sharedSelection);
    const selection = snapshot.state.selection;
    const reveal = snapshot.state.reveal;
    let cancelled = false;
    let observer: MutationObserver | undefined;
    const revealWhenReady = () => {
      if (cancelled) return true;
      const section = document.getElementById(fileAnchorId(sharedSelection));
      if (!section) return false;
      if (!reveal || reveal.kind === "file-top") {
        revealFile(sharedSelection, false);
        pendingRevealFile.current = undefined;
        return true;
      }
      let side = selection.side;
      let lineNumber = selection.line;
      if (reveal.kind === "hunk") {
        const file = snapshot.manifest.files.find((candidate) => candidate.key === sharedSelection);
        const hunk = file?.hunks[selection.hunkIndex];
        side = hunk?.newRange ? "new" : "old";
        lineNumber = (side === "new" ? hunk?.newRange : hunk?.oldRange)?.[0];
      }
      if (!side || lineNumber === undefined) return false;
      const column = side === "new" ? "additions" : "deletions";
      const line = Array.from(
        section.querySelectorAll<HTMLElement>(`[data-line="${lineNumber}"]`),
      ).find((candidate) => candidate.closest(`[data-${column}]`));
      const target =
        line ??
        (reveal.kind === "hunk"
          ? section.querySelector<HTMLElement>(`[data-review-hunk="${selection.hunkIndex}"]`)
          : null);
      if (!target) return false;
      target.scrollIntoView({ block: "center" });
      pendingRevealFile.current = undefined;
      return true;
    };
    requestAnimationFrame(() => {
      if (revealWhenReady()) return;
      observer = new MutationObserver(() => {
        if (revealWhenReady()) observer?.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    return () => {
      cancelled = true;
      if (pendingRevealFile.current === sharedSelection) pendingRevealFile.current = undefined;
      observer?.disconnect();
    };
  }, [
    snapshot.generation,
    snapshot.state.reveal?.token,
    snapshot.state.selection.fileKey,
    snapshot.state.selection.hunkIndex,
    snapshot.state.selection.side,
    snapshot.state.selection.line,
    treeSource,
    revealFile,
  ]);

  const onVisibleFile = useCallback(
    (fileKey: string) => {
      if (pendingRevealFile.current) return;
      setSelectedFileKey(fileKey);
      treeSource.selectFile(fileKey);
    },
    [treeSource],
  );

  const mutationsEnabled = connection === "connected";
  const saveUserNote = useCallback(async () => {
    const current = mirrorRef.current.getSnapshot();
    const selection = current?.state.selection;
    if (!current || !selection?.fileKey || !composerBody.trim()) return;
    const file = current.manifest.files.find((candidate) => candidate.key === selection.fileKey);
    const hunk = file?.hunks[selection.hunkIndex];
    if (!file || !hunk) return;
    const side = selection.side ?? (hunk.newRange ? "new" : "old");
    const range = side === "new" ? hunk.newRange : hunk.oldRange;
    const line = selection.line ?? range?.[0];
    if (line === undefined) return;
    if (
      await dispatchAction({
        type: "notes/create-user",
        note: {
          fileKey: file.key,
          hunkIndex: selection.hunkIndex,
          side,
          line,
          body: composerBody,
        },
      })
    ) {
      setComposerBody("");
    }
  }, [composerBody, dispatchAction]);

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
        <div className="topbar__actions">
          <button
            type="button"
            disabled={!mutationsEnabled}
            onClick={() =>
              void dispatchAction({
                type: "notes/set-visibility",
                visible: !snapshot.state.showAgentNotes,
              })
            }
          >
            {snapshot.state.showAgentNotes ? "Hide agent notes" : "Show agent notes"}
          </button>
          {snapshot.manifest.capabilities.canReload ? (
            <button
              type="button"
              disabled={!mutationsEnabled}
              onClick={() => void dispatchAction({ type: "session/reload" })}
            >
              Reload
            </button>
          ) : null}
          <ConnectionStatus state={connection} />
        </div>
      </header>
      <aside className="sidebar">
        <div className="review-summary">
          <h1>{snapshot.manifest.title}</h1>
          {snapshot.manifest.summary ? <p>{snapshot.manifest.summary}</p> : null}
          {snapshot.manifest.agentSummary ? <p>{snapshot.manifest.agentSummary}</p> : null}
          <span>
            {visible.files.length} of {snapshot.manifest.files.length} changed files
          </span>
          <label className="semantic-filter">
            <span>Review filter</span>
            <input
              aria-label="Review file filter"
              disabled={!mutationsEnabled}
              value={sharedFilter}
              onChange={(event) => setSharedFilter(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void dispatchAction({ type: "filter/set", filter: sharedFilter });
                }
              }}
            />
          </label>
          <button
            type="button"
            disabled={!mutationsEnabled || sharedFilter === snapshot.state.filter}
            onClick={() => void dispatchAction({ type: "filter/set", filter: sharedFilter })}
          >
            Apply filter
          </button>
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
          mutationsEnabled={mutationsEnabled}
          stateRevision={snapshot.state.stateRevision}
          expandedGaps={snapshot.state.expandedGaps ?? EMPTY_EXPANDED_GAPS}
          sourceStatusByFileKey={snapshot.state.sourceStatusByFileKey ?? EMPTY_SOURCE_STATUSES}
          onAction={dispatchAction}
        />
        <section className="note-composer" aria-label="Add review note">
          <label>
            <span>Note at selected line or hunk</span>
            <textarea
              value={composerBody}
              disabled={!mutationsEnabled}
              onChange={(event) => setComposerBody(event.currentTarget.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void saveUserNote();
                }
              }}
            />
          </label>
          <button
            type="button"
            disabled={!mutationsEnabled || !composerBody.trim()}
            onClick={() => void saveUserNote()}
          >
            Add note <kbd>⌘/Ctrl Enter</kbd>
          </button>
        </section>
      </main>
      {snapshot.state.trustPromptRepoRoot ? (
        <div
          className="trust-prompt"
          role="dialog"
          aria-modal="true"
          aria-label="Repository extension trust"
        >
          <strong>Run this repository’s extensions?</strong>
          <span>{snapshot.state.trustPromptRepoRoot}</span>
          <div>
            <button
              disabled={!mutationsEnabled}
              onClick={() => void dispatchAction({ type: "trust/decide", decision: "denied" })}
            >
              Deny
            </button>
            <button
              disabled={!mutationsEnabled}
              onClick={() => void dispatchAction({ type: "trust/decide", decision: "trusted" })}
            >
              Trust and reload
            </button>
          </div>
        </div>
      ) : null}
      {actionMessage ? (
        <div className="action-banner" role="alert">
          {actionMessage}
        </div>
      ) : null}
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
    connected: "Live",
    reconnecting: "Reconnecting…",
    disconnected: "Disconnected",
    expired: "Expired",
  };
  return <span className={`connection connection--${state}`}>{labels[state]}</span>;
}

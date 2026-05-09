import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useRenderer } from "@opentui/react";
import { resolveConfiguredCliInput } from "../core/config";
import { loadAppBootstrap } from "../core/loaders";
import { resolveRuntimeCliInput } from "../core/terminal";
import type {
  AppBootstrap,
  CliInput,
  CommitChangeset,
  DiffFile,
  ViewPreferences,
} from "../core/types";
import type { UpdateNotice } from "../core/updateNotice";
import {
  createInitialSessionSnapshot,
  updateSessionRegistration,
} from "../hunk-session/sessionRegistration";
import type { HunkSessionBrokerClient, LiveComment } from "../hunk-session/types";
import { App } from "./App";
import { useStartupUpdateNotice } from "./hooks/useStartupUpdateNotice";
import { resolveTheme } from "./themes";

/** Result returned by `onMoveCommit` so the caller can detect blocked moves. */
export type MoveCommitResult =
  | { kind: "moved"; index: number }
  | { kind: "at-edge" }
  | { kind: "waiting-on-stream" }
  | { kind: "no-buffer" };

/** Keep one live Hunk app mounted while allowing daemon-driven session reloads. */
export function AppHost({
  bootstrap,
  hostClient,
  onQuit = () => process.exit(0),
  startupNoticeResolver,
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkSessionBrokerClient;
  onQuit?: () => void;
  startupNoticeResolver?: () => Promise<UpdateNotice | null>;
}) {
  const [activeBootstrap, setActiveBootstrap] = useState(bootstrap);
  const [appVersion, setAppVersion] = useState(0);
  // Commit-review state. `commitBuffer` retains every parsed commit (100% backward
  // retention by design); `cursorIndex` points to the active one. Both are unused when
  // the source isn't a commit-by-commit stream.
  const [commitBuffer, setCommitBuffer] = useState<CommitChangeset[]>([]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [commitStreamComplete, setCommitStreamComplete] = useState(false);
  // View preferences and the live-comment store both live at AppHost so they survive
  // the App remount that fires on every commit-cursor move. App's view-state reset on
  // commit nav is intentional for selection / scroll / filter (they don't translate
  // across commits), but the toggles a user has set and the notes they've left should
  // follow them. Live comments are bucketed by the active changeset's id so each commit
  // (or each non-commit-review canvas) keeps its own annotation set; switching back to
  // a previously visited commit restores its notes.
  const renderer = useRenderer();
  const [view, setView] = useState<ViewPreferences>(() => ({
    layoutMode: bootstrap.initialMode,
    themeId: resolveTheme(bootstrap.initialTheme, renderer.themeMode).id,
    showAgentNotes: bootstrap.initialShowAgentNotes ?? false,
    showLineNumbers: bootstrap.initialShowLineNumbers ?? true,
    wrapLines: bootstrap.initialWrapLines ?? false,
    showHunkHeaders: bootstrap.initialShowHunkHeaders ?? true,
    // Pager-bare mode (`hunk pager` without commit-review) starts with the sidebar
    // hidden because the chrome is intentionally minimal there. Commit-review and
    // every other input start with the sidebar visible.
    sidebarVisible: !(bootstrap.input.options.pager && !bootstrap.commitReviewStream),
    forceSidebarOpen: false,
    commitDetailsMode: bootstrap.initialCommitDetailsMode ?? "full",
  }));
  const updateView = useCallback((patch: Partial<ViewPreferences>) => {
    setView((current) => ({ ...current, ...patch }));
  }, []);
  const [liveCommentsByReviewKey, setLiveCommentsByReviewKey] = useState<
    Record<string, Record<string, LiveComment[]>>
  >({});
  // Bucket key is the active changeset's id rather than the commit sha. The producer
  // already builds it as `commit:<sha>` for normal commits and `commit:anonymous:N`
  // for commits with no parsed sha, so anonymous commits each get their own bucket
  // instead of colliding on an empty-string key.
  const currentReviewKey = activeBootstrap.changeset.id;
  const liveCommentsByFileId = useMemo<Record<string, LiveComment[]>>(
    () => liveCommentsByReviewKey[currentReviewKey] ?? {},
    [liveCommentsByReviewKey, currentReviewKey],
  );
  // Updater scoped to the current review's slice. Forwarding an updater here keeps the
  // controlled-hook pattern in useReviewController (functional and value setters both
  // work) while AppHost decides which review-key bucket the writes land in.
  const setLiveCommentsByFileId = useCallback<
    Dispatch<SetStateAction<Record<string, LiveComment[]>>>
  >(
    (action) => {
      setLiveCommentsByReviewKey((byKey) => {
        const currentSlice = byKey[currentReviewKey] ?? {};
        const nextSlice =
          typeof action === "function"
            ? (action as (prev: Record<string, LiveComment[]>) => Record<string, LiveComment[]>)(
                currentSlice,
              )
            : action;
        if (nextSlice === currentSlice) return byKey;
        return { ...byKey, [currentReviewKey]: nextSlice };
      });
    },
    [currentReviewKey],
  );
  // Keep a ref to the latest buffer length so synchronous handlers (move-by-key) can
  // read it without re-binding on every state update.
  const commitBufferRef = useRef<CommitChangeset[]>([]);
  commitBufferRef.current = commitBuffer;
  const cursorIndexRef = useRef(0);
  cursorIndexRef.current = cursorIndex;

  const startupNoticeText = useStartupUpdateNotice({
    enabled: !bootstrap.input.options.pager,
    resolver: startupNoticeResolver,
  });

  // Subscribe to the flat-streaming changeset producer when one is provided. Used by
  // the explicit --no-review path.
  useEffect(() => {
    const stream = bootstrap.stream;
    if (!stream) return;
    const unsubscribe = stream.subscribe({
      onAppend: (files: DiffFile[]) =>
        setActiveBootstrap((prev) => ({
          ...prev,
          changeset: {
            ...prev.changeset,
            files: [...prev.changeset.files, ...files],
            isStreaming: true,
          },
        })),
      onComplete: () =>
        setActiveBootstrap((prev) => ({
          ...prev,
          changeset: { ...prev.changeset, isStreaming: false },
        })),
      onError: (err) => {
        console.warn(`[hunk:pager-stream] ${err.message}`);
        setActiveBootstrap((prev) => ({
          ...prev,
          changeset: { ...prev.changeset, isStreaming: false },
        }));
      },
    });
    return () => {
      unsubscribe();
      stream.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to the commit-review producer for `git log -p` style input. Each emitted
  // CommitChangeset gets appended to the buffer; the cursor stays put unless the user
  // moves it.
  useEffect(() => {
    const stream = bootstrap.commitReviewStream;
    if (!stream) return;
    const unsubscribe = stream.subscribe({
      onCommit: (commit) =>
        setCommitBuffer((prev) => {
          // De-dup against late replays. Key off changeset.id rather than metadata.sha:
          // anonymous commits (no parsed sha) all share `metadata.sha = ""`, which would
          // collapse the entire anonymous tail of a malformed log into a single entry.
          // changeset.id is `commit:<sha>` for normal commits and `commit:anonymous:N`
          // for anonymous ones, so distinct entries stay distinct.
          if (prev.some((c) => c.changeset.id === commit.changeset.id)) return prev;
          return [...prev, commit];
        }),
      onComplete: () => setCommitStreamComplete(true),
      onError: (err) => {
        console.warn(`[hunk:pager-stream] ${err.message}`);
        setCommitStreamComplete(true);
      },
    });
    return () => {
      unsubscribe();
      stream.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever the cursor or the commit at the cursor changes, swap the active bootstrap
  // to that commit's changeset. Bumps appVersion so the App remounts with a fresh
  // selection / scroll baseline — moving between commits should feel like opening a new
  // review canvas, not like scrolling within a single one.
  // Key off changeset.id rather than metadata.sha so anonymous commits (which all
  // share an empty sha) each register as a fresh swap rather than collapsing into
  // a single "no-sha" identity.
  const lastSwappedReviewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bootstrap.commitReviewStream) return;
    const commit = commitBuffer[cursorIndex];
    if (!commit) return;
    if (lastSwappedReviewKeyRef.current === commit.changeset.id) {
      // Same commit; just keep the cursor info on the bootstrap up to date so the
      // streaming/total counts can reflect newly arrived commits behind the scenes.
      setActiveBootstrap((prev) => ({
        ...prev,
        commitCursor: {
          current: cursorIndex,
          total: commitBuffer.length,
          streaming: !commitStreamComplete,
        },
      }));
      return;
    }
    lastSwappedReviewKeyRef.current = commit.changeset.id;

    const nextBootstrap: AppBootstrap = {
      ...bootstrap,
      changeset: commit.changeset,
      currentCommit: commit.metadata,
      commitCursor: {
        current: cursorIndex,
        total: commitBuffer.length,
        streaming: !commitStreamComplete,
      },
    };

    if (hostClient) {
      // Refresh the daemon's view: same session id, new info.files. Skill clients
      // detect the commit transition by polling commitCursor.currentCommitId or by
      // seeing the file list change wholesale.
      const nextRegistration = updateSessionRegistration(
        hostClient.getRegistration(),
        nextBootstrap,
      );
      const nextSnapshot = createInitialSessionSnapshot(nextBootstrap);
      hostClient.replaceSession(nextRegistration, nextSnapshot);
    }

    setActiveBootstrap(nextBootstrap);
    setAppVersion((prev) => prev + 1);

    // Tell the producer where the cursor is so it can apply back-pressure.
    bootstrap.commitReviewStream.setConsumedCommitIndex(cursorIndex);
  }, [bootstrap, commitBuffer, cursorIndex, commitStreamComplete, hostClient]);

  /**
   * Move the commit cursor by `delta` positions. Returns a discriminated result so the
   * caller can decide whether to show "no more commits" or "waiting for next commit"
   * UX. Called by the App's keyboard handler after any confirmation prompt has cleared.
   */
  const onMoveCommit = useCallback((delta: number): MoveCommitResult => {
    const buffer = commitBufferRef.current;
    if (buffer.length === 0) return { kind: "no-buffer" };
    const current = cursorIndexRef.current;
    const target = current + delta;
    if (target < 0) return { kind: "at-edge" };
    if (target >= buffer.length) return { kind: "waiting-on-stream" };
    setCursorIndex(target);
    return { kind: "moved", index: target };
  }, []);

  const reloadSession = useCallback(
    async (nextInput: CliInput, options?: { resetApp?: boolean; sourcePath?: string }) => {
      const runtimeInput = resolveRuntimeCliInput(nextInput);
      const configuredInput = resolveConfiguredCliInput(runtimeInput, {
        cwd: options?.sourcePath,
      }).input;
      const nextBootstrap = await loadAppBootstrap(configuredInput, {
        cwd: options?.sourcePath,
      });
      const nextSnapshot = createInitialSessionSnapshot(nextBootstrap);

      let sessionId = "local-session";
      if (hostClient) {
        const nextRegistration = updateSessionRegistration(
          hostClient.getRegistration(),
          nextBootstrap,
        );
        sessionId = nextRegistration.sessionId;
        hostClient.replaceSession(nextRegistration, nextSnapshot);
      }

      setActiveBootstrap(nextBootstrap);
      if (options?.resetApp !== false) {
        // A full reload is a fresh review canvas — drop any cached per-review comments
        // since the file IDs and content no longer correspond to the new bootstrap.
        setLiveCommentsByReviewKey({});
        setAppVersion((current) => current + 1);
      }

      return {
        sessionId,
        inputKind: nextBootstrap.input.kind,
        title: nextBootstrap.changeset.title,
        sourceLabel: nextBootstrap.changeset.sourceLabel,
        fileCount: nextBootstrap.changeset.files.length,
        selectedFilePath: nextSnapshot.state.selectedFilePath,
        selectedHunkIndex: nextSnapshot.state.selectedHunkIndex,
      };
    },
    [hostClient],
  );

  return (
    <App
      key={appVersion}
      bootstrap={activeBootstrap}
      hostClient={hostClient}
      noticeText={startupNoticeText}
      onQuit={onQuit}
      onReloadSession={reloadSession}
      onMoveCommit={bootstrap.commitReviewStream ? onMoveCommit : undefined}
      view={view}
      updateView={updateView}
      liveCommentsByFileId={liveCommentsByFileId}
      setLiveCommentsByFileId={setLiveCommentsByFileId}
    />
  );
}

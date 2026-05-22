import { isDeepStrictEqual } from "node:util";
import { resolveConfiguredCliInput } from "../core/config";
import {
  buildLiveComment,
  findDiffFileByPath,
  hunkLineRange,
  resolveCommentTarget,
} from "../core/liveComments";
import { loadAppBootstrap } from "../core/loaders";
import type { AppBootstrap, CliInput, CommonOptions } from "../core/types";
import { createHunkSessionBridge } from "../hunk-session/bridge";
import {
  createInitialSessionSnapshot,
  createSessionRegistration,
  updateSessionRegistration,
} from "../hunk-session/sessionRegistration";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  HunkSessionBrokerClient,
  HunkSessionCommandResult,
  HunkSessionRegistration,
  HunkSessionServerMessage,
  HunkSessionSnapshot,
  LiveComment,
  NavigatedSelectionResult,
  RemovedCommentResult,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "../hunk-session/types";
import { SessionBrokerClient } from "../session-broker/brokerClient";
import { reviewNoteSource } from "../ui/lib/agentAnnotations";
import { buildSelectedHunkSummary, resolveReviewNavigationTarget } from "../ui/lib/reviewState";
import { createEmbeddedSessionBrokerAvailability } from "./daemon";
import type {
  CreateEmbeddedHunkSessionInput,
  EmbeddedHunkSession,
  EmbeddedHunkSnapshot,
  EmbeddedHunkSource,
} from "./types";

export type EmbeddedHunkRenderSnapshot =
  | { status: "loading"; bootstrap: AppBootstrap; error?: undefined }
  | { status: "ready"; bootstrap: AppBootstrap; error?: undefined }
  | { status: "error"; bootstrap: AppBootstrap; error: string };

type NormalizedEmbeddedHunkSource = EmbeddedHunkSource & { options: CommonOptions };

/** Drop undefined option entries so equivalent embedded sources compare the same. */
function normalizeEmbeddedOptions(options: EmbeddedHunkSource["options"] = {}): CommonOptions {
  const normalized = { ...options };
  for (const key of Object.keys(normalized) as Array<keyof typeof normalized>) {
    if (normalized[key] === undefined) delete normalized[key];
  }
  return normalized;
}

/** Return a session-owned source copy with normalized options and pathspec identity. */
function normalizeEmbeddedHunkSource(source: EmbeddedHunkSource): NormalizedEmbeddedHunkSource {
  const normalized = {
    ...source,
    options: normalizeEmbeddedOptions(source.options),
  } as NormalizedEmbeddedHunkSource;

  if ("pathspecs" in normalized) {
    if (normalized.pathspecs === undefined) {
      delete normalized.pathspecs;
    } else {
      normalized.pathspecs = [...normalized.pathspecs];
    }
  }

  return normalized;
}

/** Adapt a public embedded source into the internal CLI input pipeline. */
function embeddedSourceToCliInput(source: EmbeddedHunkSource): CliInput {
  const normalized = normalizeEmbeddedHunkSource(source);

  switch (normalized.kind) {
    case "worktree":
      return {
        kind: "vcs",
        staged: false,
        pathspecs: normalized.pathspecs,
        options: normalized.options,
      };
    case "staged":
      return {
        kind: "vcs",
        staged: true,
        pathspecs: normalized.pathspecs,
        options: normalized.options,
      };
    case "patch":
      return {
        kind: "patch",
        text: normalized.text,
        file: normalized.file ?? normalized.label,
        options: normalized.options,
      };
    default:
      return normalized as CliInput;
  }
}

/** Resolve embedded input through the same config layers as the CLI. */
function resolveEmbeddedCliInput(source: EmbeddedHunkSource, cwd: string) {
  return resolveConfiguredCliInput(embeddedSourceToCliInput(source), { cwd }).input;
}

/** Build the host-facing embedded snapshot without exposing app bootstrap internals. */
function publicSnapshot(
  source: EmbeddedHunkSource,
  snapshot: EmbeddedHunkRenderSnapshot,
): EmbeddedHunkSnapshot {
  if (snapshot.status === "loading") {
    return { status: "loading", source };
  }

  const base = {
    source,
    title: snapshot.bootstrap.changeset.title,
    fileCount: snapshot.bootstrap.changeset.files.length,
  };
  return snapshot.status === "error"
    ? { ...base, status: "error", error: snapshot.error }
    : { ...base, status: "ready" };
}

/** Convert one live comment into the broker snapshot's summary shape. */
function summarizeLiveComment(comment: LiveComment): SessionLiveCommentSummary {
  return {
    commentId: comment.id,
    filePath: comment.filePath,
    hunkIndex: comment.hunkIndex,
    side: comment.side,
    line: comment.line,
    summary: comment.summary,
    rationale: comment.rationale,
    author: comment.author,
    createdAt: comment.createdAt,
  };
}

/** Rehydrate broker snapshot comments into the session-owned live annotation map. */
function liveCommentsByFileFromSnapshot(
  bootstrap: AppBootstrap,
  comments: SessionLiveCommentSummary[],
) {
  const byFileId: Record<string, LiveComment[]> = {};
  comments.forEach((comment) => {
    const file = findDiffFileByPath(bootstrap.changeset.files, comment.filePath);
    if (!file) {
      return;
    }

    byFileId[file.id] = [
      ...(byFileId[file.id] ?? []),
      {
        id: comment.commentId,
        source: "mcp",
        filePath: comment.filePath,
        hunkIndex: comment.hunkIndex,
        side: comment.side,
        line: comment.line,
        summary: comment.summary,
        rationale: comment.rationale,
        author: comment.author,
        createdAt: comment.createdAt,
        oldRange: comment.side === "old" ? [comment.line, comment.line] : undefined,
        newRange: comment.side === "new" ? [comment.line, comment.line] : undefined,
        tags: ["mcp"],
        confidence: "high",
      },
    ];
  });

  return byFileId;
}

/** Own one embedded Hunk review session, including source identity and broker registration. */
class EmbeddedHunkSessionImpl implements EmbeddedHunkSession {
  private listeners = new Set<() => void>();
  private disposed = false;
  private renderSnapshot: EmbeddedHunkRenderSnapshot;
  private sessionSnapshot: HunkSessionSnapshot;
  private liveCommentsByFileId: Record<string, LiveComment[]> = {};
  private mountedBridge: Parameters<HunkSessionBrokerClient["setBridge"]>[0] = null;

  readonly brokerClient: HunkSessionBrokerClient;
  readonly hostClient: HunkSessionBrokerClient;

  constructor(
    readonly cwd: string,
    public source: EmbeddedHunkSource,
    bootstrap: AppBootstrap,
  ) {
    this.renderSnapshot = { status: "ready", bootstrap };
    this.sessionSnapshot = createInitialSessionSnapshot(bootstrap);
    this.brokerClient = new SessionBrokerClient(
      createSessionRegistration(bootstrap, { cwd }),
      this.sessionSnapshot,
      {
        ensureBrokerAvailable: createEmbeddedSessionBrokerAvailability({ cwd }),
      },
    );
    this.brokerClient.setBridge({
      dispatchCommand: (message) => this.dispatchCommand(message),
    });
    this.hostClient = this.createMountedHostClient();
    this.brokerClient.start();
  }

  getSnapshot = () => publicSnapshot(this.source, this.renderSnapshot);

  getRenderSnapshot = () => this.renderSnapshot;

  getSessionSnapshot = () => this.sessionSnapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Open a source idempotently; callers can re-open without learning source identity rules. */
  async open(source: EmbeddedHunkSource) {
    const nextSource = normalizeEmbeddedHunkSource(source);
    if (this.disposed || isDeepStrictEqual(normalizeEmbeddedHunkSource(this.source), nextSource)) {
      return this.getSnapshot();
    }
    return this.load(nextSource, { updateSource: true });
  }

  /** Reload the currently loaded source, preserving source identity for the host. */
  async reload() {
    if (this.disposed) return this.getSnapshot();
    return this.load(this.source, { updateSource: false });
  }

  /** Dispatch session-broker commands through the mounted UI when available, otherwise headlessly. */
  async dispatchCommand(message: HunkSessionServerMessage): Promise<HunkSessionCommandResult> {
    if (this.mountedBridge) {
      return this.mountedBridge.dispatchCommand(message);
    }

    const bridge = createHunkSessionBridge({
      addLiveComment: (input, commentId, options) =>
        this.addHeadlessLiveComment(input, commentId, options),
      addLiveCommentBatch: (inputs, requestId, options) =>
        this.addHeadlessLiveCommentBatch(inputs, requestId, options),
      clearLiveComments: (filePath) => this.clearHeadlessLiveComments(filePath),
      navigateToLocation: (input) => this.navigateHeadless(input),
      openAgentNotes: () => this.setHeadlessAgentNotesVisible(true),
      reloadSession: async (nextInput) => {
        const result = await this.load(nextInput as EmbeddedHunkSource, {
          updateSource: true,
        });
        return {
          sessionId: this.brokerClient.getRegistration().sessionId,
          inputKind: this.renderSnapshot.bootstrap.input.kind,
          title:
            result.status === "ready"
              ? result.title
              : this.renderSnapshot.bootstrap.changeset.title,
          sourceLabel: this.renderSnapshot.bootstrap.changeset.sourceLabel,
          fileCount: this.renderSnapshot.bootstrap.changeset.files.length,
          selectedFilePath: this.sessionSnapshot.state.selectedFilePath,
          selectedHunkIndex: this.sessionSnapshot.state.selectedHunkIndex,
        };
      },
      removeLiveComment: (commentId) => this.removeHeadlessLiveComment(commentId),
    });

    return bridge.dispatchCommand(message);
  }

  dispose() {
    this.disposed = true;
    this.brokerClient.stop();
    this.listeners.clear();
  }

  private async load(
    source: EmbeddedHunkSource,
    { updateSource }: { updateSource: boolean },
  ): Promise<EmbeddedHunkSnapshot> {
    this.setRenderSnapshot({
      status: "loading",
      bootstrap: this.renderSnapshot.bootstrap,
    });

    try {
      const bootstrap = await loadAppBootstrap(resolveEmbeddedCliInput(source, this.cwd), {
        cwd: this.cwd,
      });
      if (updateSource) {
        this.source = source;
      }
      this.liveCommentsByFileId = {};
      this.sessionSnapshot = createInitialSessionSnapshot(bootstrap);
      this.brokerClient.replaceSession(
        updateSessionRegistration(this.brokerClient.getRegistration(), bootstrap),
        this.sessionSnapshot,
      );
      this.setRenderSnapshot({ status: "ready", bootstrap });
      return this.getSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setRenderSnapshot({
        status: "error",
        bootstrap: this.renderSnapshot.bootstrap,
        error: message,
      });
      throw error;
    }
  }

  private setRenderSnapshot(snapshot: EmbeddedHunkRenderSnapshot) {
    this.renderSnapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  /** Build the host client facade used by mounted React apps without giving up headless handling. */
  private createMountedHostClient(): HunkSessionBrokerClient {
    return {
      getRegistration: () => this.brokerClient.getRegistration(),
      replaceSession: (registration: HunkSessionRegistration, snapshot: HunkSessionSnapshot) => {
        this.persistSessionSnapshot(snapshot);
        this.brokerClient.replaceSession(registration, snapshot);
      },
      setBridge: (bridge: Parameters<HunkSessionBrokerClient["setBridge"]>[0]) => {
        this.mountedBridge = bridge;
      },
      start: () => this.brokerClient.start(),
      stop: () => this.brokerClient.stop(),
      updateSnapshot: (snapshot: HunkSessionSnapshot) => {
        this.persistSessionSnapshot(snapshot);
        this.brokerClient.updateSnapshot(snapshot);
      },
    } as HunkSessionBrokerClient;
  }

  /** Persist the latest mounted-app snapshot so future embedded mounts start from it. */
  private persistSessionSnapshot(snapshot: HunkSessionSnapshot) {
    this.sessionSnapshot = snapshot;
    this.liveCommentsByFileId = liveCommentsByFileFromSnapshot(
      this.renderSnapshot.bootstrap,
      snapshot.state.liveComments,
    );
  }

  /** Return all session-owned live comments in file order. */
  private liveCommentSummaries() {
    return this.renderSnapshot.bootstrap.changeset.files.flatMap((file) =>
      (this.liveCommentsByFileId[file.id] ?? []).map(summarizeLiveComment),
    );
  }

  /** Return all review notes visible to session commands, including headless live comments. */
  private reviewNoteSummaries(): SessionReviewNoteSummary[] {
    const summaries: SessionReviewNoteSummary[] = [];

    this.renderSnapshot.bootstrap.changeset.files.forEach((file) => {
      (file.agent?.annotations ?? []).forEach((annotation, index) => {
        const source = reviewNoteSource(annotation);
        summaries.push({
          noteId: annotation.id ?? `${source}:${file.id}:${index}`,
          source,
          filePath: file.path,
          oldRange: annotation.oldRange,
          newRange: annotation.newRange,
          body: [annotation.summary, annotation.rationale].filter(Boolean).join("\n\n"),
          title: annotation.title,
          author: annotation.author,
          createdAt: annotation.createdAt ?? "1970-01-01T00:00:00.000Z",
          updatedAt: annotation.updatedAt,
          editable: false,
        });
      });

      (this.liveCommentsByFileId[file.id] ?? []).forEach((comment) => {
        summaries.push({
          noteId: comment.id,
          source: "agent",
          filePath: file.path,
          hunkIndex: comment.hunkIndex,
          oldRange: comment.oldRange,
          newRange: comment.newRange,
          body: [comment.summary, comment.rationale].filter(Boolean).join("\n\n"),
          author: comment.author,
          createdAt: comment.createdAt,
          editable: false,
        });
      });
    });

    return summaries;
  }

  /** Publish the current session-owned review state to the daemon. */
  private updateHeadlessSnapshot() {
    const liveComments = this.liveCommentSummaries();
    const reviewNotes = this.reviewNoteSummaries();
    this.sessionSnapshot = {
      updatedAt: new Date().toISOString(),
      state: {
        ...this.sessionSnapshot.state,
        liveCommentCount: liveComments.length,
        liveComments,
        reviewNoteCount: reviewNotes.length,
        reviewNotes,
      },
    };
    this.brokerClient.updateSnapshot(this.sessionSnapshot);
    for (const listener of this.listeners) listener();
  }

  /** Update the persisted agent-note visibility bit. */
  private setHeadlessAgentNotesVisible(visible: boolean) {
    this.sessionSnapshot = {
      ...this.sessionSnapshot,
      state: {
        ...this.sessionSnapshot.state,
        showAgentNotes: visible,
      },
    };
    this.updateHeadlessSnapshot();
  }

  /** Add one live agent comment to the session-owned review state. */
  private addHeadlessLiveComment(
    input: Extract<HunkSessionServerMessage, { command: "comment" }>["input"],
    commentId: string,
    options?: { reveal?: boolean },
  ): AppliedCommentResult {
    const file = findDiffFileByPath(this.renderSnapshot.bootstrap.changeset.files, input.filePath);
    if (!file) {
      throw new Error(`No diff file matches ${input.filePath}.`);
    }

    const target = resolveCommentTarget(file, input);
    const liveComment = buildLiveComment(
      {
        ...input,
        side: target.side,
        line: target.line,
      },
      commentId,
      new Date().toISOString(),
      target.hunkIndex,
    );
    this.liveCommentsByFileId[file.id] = [
      ...(this.liveCommentsByFileId[file.id] ?? []),
      liveComment,
    ];

    if (options?.reveal ?? false) {
      this.selectHeadlessHunk(file.id, file.path, target.hunkIndex);
      this.sessionSnapshot.state.showAgentNotes = true;
    }

    this.updateHeadlessSnapshot();
    return {
      commentId,
      fileId: file.id,
      filePath: file.path,
      hunkIndex: target.hunkIndex,
      side: target.side,
      line: target.line,
    };
  }

  /** Apply a validated batch of live comments to the session-owned review state. */
  private addHeadlessLiveCommentBatch(
    inputs: Extract<HunkSessionServerMessage, { command: "comment_batch" }>["input"]["comments"],
    requestId: string,
    options?: { revealMode?: "none" | "first" },
  ): AppliedCommentBatchResult {
    const createdAt = new Date().toISOString();
    const prepared = inputs.map((input, index) => {
      const file = findDiffFileByPath(
        this.renderSnapshot.bootstrap.changeset.files,
        input.filePath,
      );
      if (!file) {
        throw new Error(`No diff file matches ${input.filePath}.`);
      }

      const target = resolveCommentTarget(file, input);
      return {
        file,
        target,
        liveComment: buildLiveComment(
          {
            ...input,
            side: target.side,
            line: target.line,
          },
          `mcp:${requestId}:${index}`,
          createdAt,
          target.hunkIndex,
        ),
      };
    });

    prepared.forEach(({ file, liveComment }) => {
      this.liveCommentsByFileId[file.id] = [
        ...(this.liveCommentsByFileId[file.id] ?? []),
        liveComment,
      ];
    });

    if (options?.revealMode === "first" && prepared.length > 0) {
      const first = prepared[0]!;
      this.selectHeadlessHunk(first.file.id, first.file.path, first.target.hunkIndex);
      this.sessionSnapshot.state.showAgentNotes = true;
    }

    this.updateHeadlessSnapshot();
    return {
      applied: prepared.map(({ file, target, liveComment }) => ({
        commentId: liveComment.id,
        fileId: file.id,
        filePath: file.path,
        hunkIndex: target.hunkIndex,
        side: target.side,
        line: target.line,
      })),
    };
  }

  /** Navigate the persisted hidden-session selection. */
  private navigateHeadless(
    input: Extract<HunkSessionServerMessage, { command: "navigate_to_hunk" }>["input"],
  ): NavigatedSelectionResult {
    const files = this.renderSnapshot.bootstrap.changeset.files;
    const target = resolveReviewNavigationTarget({
      allFiles: files,
      currentFileId: this.sessionSnapshot.state.selectedFileId,
      currentHunkIndex: this.sessionSnapshot.state.selectedHunkIndex,
      input,
      visibleFiles: files,
    });
    this.selectHeadlessHunk(target.file.id, target.file.path, target.hunkIndex);
    this.updateHeadlessSnapshot();
    return {
      fileId: target.file.id,
      filePath: target.file.path,
      hunkIndex: target.hunkIndex,
      selectedHunk: buildSelectedHunkSummary(target.file, target.hunkIndex),
    };
  }

  /** Remove one persisted live comment. */
  private removeHeadlessLiveComment(commentId: string): RemovedCommentResult {
    let removed = false;
    let remainingCommentCount = 0;
    const next: Record<string, LiveComment[]> = {};

    for (const [fileId, comments] of Object.entries(this.liveCommentsByFileId)) {
      const filtered = comments.filter((comment) => comment.id !== commentId);
      if (filtered.length !== comments.length) {
        removed = true;
      }
      if (filtered.length > 0) {
        next[fileId] = filtered;
        remainingCommentCount += filtered.length;
      }
    }

    if (!removed) {
      throw new Error(`No live comment matches id ${commentId}.`);
    }

    this.liveCommentsByFileId = next;
    this.updateHeadlessSnapshot();
    return { commentId, removed: true, remainingCommentCount };
  }

  /** Clear persisted live comments, optionally scoped to one file. */
  private clearHeadlessLiveComments(filePath?: string): ClearedCommentsResult {
    let removedCount = 0;
    let remainingCommentCount = 0;

    if (filePath) {
      const file = findDiffFileByPath(this.renderSnapshot.bootstrap.changeset.files, filePath);
      if (!file) {
        throw new Error(`No diff file matches ${filePath}.`);
      }

      const next: Record<string, LiveComment[]> = {};
      for (const [fileId, comments] of Object.entries(this.liveCommentsByFileId)) {
        if (fileId === file.id) {
          removedCount = comments.length;
          continue;
        }
        next[fileId] = comments;
        remainingCommentCount += comments.length;
      }
      this.liveCommentsByFileId = next;
    } else {
      removedCount = Object.values(this.liveCommentsByFileId).reduce(
        (sum, comments) => sum + comments.length,
        0,
      );
      this.liveCommentsByFileId = {};
    }

    this.updateHeadlessSnapshot();
    return { removedCount, remainingCommentCount, filePath };
  }

  /** Update the persisted selection fields from one file/hunk target. */
  private selectHeadlessHunk(fileId: string, filePath: string, hunkIndex: number) {
    const file = this.renderSnapshot.bootstrap.changeset.files.find(
      (candidate) => candidate.id === fileId,
    );
    const hunk = file?.metadata.hunks[hunkIndex];
    const range = hunk ? hunkLineRange(hunk) : null;
    this.sessionSnapshot.state.selectedFileId = fileId;
    this.sessionSnapshot.state.selectedFilePath = filePath;
    this.sessionSnapshot.state.selectedHunkIndex = hunkIndex;
    this.sessionSnapshot.state.selectedHunkOldRange = range?.oldRange;
    this.sessionSnapshot.state.selectedHunkNewRange = range?.newRange;
  }
}

/** Resolve private render state for sessions created by this embedded entrypoint. */
export function embeddedHunkSessionInternals(session: EmbeddedHunkSession) {
  if (session instanceof EmbeddedHunkSessionImpl) {
    return {
      dispatchCommand: session.dispatchCommand.bind(session),
      getRenderSnapshot: session.getRenderSnapshot,
      getSessionSnapshot: session.getSessionSnapshot,
      hostClient: session.hostClient,
    };
  }
  throw new Error("mountEmbeddedHunkApp requires a session from createEmbeddedHunkSession.");
}

/** Create one embedded Hunk review session from a public embedded source. */
export async function createEmbeddedHunkSession({
  cwd = process.cwd(),
  source,
}: CreateEmbeddedHunkSessionInput): Promise<EmbeddedHunkSession> {
  const normalizedSource = normalizeEmbeddedHunkSource(source);
  const bootstrap = await loadAppBootstrap(resolveEmbeddedCliInput(normalizedSource, cwd), { cwd });
  return new EmbeddedHunkSessionImpl(cwd, normalizedSource, bootstrap);
}

import { isDeepStrictEqual } from "node:util";
import { resolveConfiguredCliInput } from "../core/config";
import { loadAppBootstrap } from "../core/loaders";
import type { AppBootstrap, CliInput, CommonOptions } from "../core/types";
import { createHunkSessionBridge } from "../hunk-session/bridge";
import {
  addReviewLiveComment,
  addReviewLiveCommentBatch,
  buildReviewSessionSnapshot,
  clearReviewLiveComments,
  createReviewCommandState,
  navigateReviewCommandState,
  reviewCommandFiles,
  removeReviewLiveComment,
  setReviewAgentNotesVisible,
  type ReviewCommandState,
} from "../hunk-session/reviewCommandState";
import {
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
  NavigatedSelectionResult,
  RemovedCommentResult,
} from "../hunk-session/types";
import { SessionBrokerClient } from "../session-broker/brokerClient";
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

/** Own one embedded Hunk review session, including source identity and broker registration. */
class EmbeddedHunkSessionImpl implements EmbeddedHunkSession {
  private listeners = new Set<() => void>();
  private disposed = false;
  private renderSnapshot: EmbeddedHunkRenderSnapshot;
  private reviewState: ReviewCommandState;
  private sessionSnapshot: HunkSessionSnapshot;
  private mountedBridge: Parameters<HunkSessionBrokerClient["setBridge"]>[0] = null;

  readonly brokerClient: HunkSessionBrokerClient;
  readonly hostClient: HunkSessionBrokerClient;

  constructor(
    readonly cwd: string,
    public source: EmbeddedHunkSource,
    bootstrap: AppBootstrap,
  ) {
    this.renderSnapshot = { status: "ready", bootstrap };
    this.reviewState = createReviewCommandState({
      files: bootstrap.changeset.files,
      initialShowAgentNotes: bootstrap.initialShowAgentNotes ?? false,
    });
    this.sessionSnapshot = this.buildSessionSnapshot();
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
      addLiveComment: this.addHeadlessLiveComment.bind(this),
      addLiveCommentBatch: this.addHeadlessLiveCommentBatch.bind(this),
      clearLiveComments: this.clearHeadlessLiveComments.bind(this),
      navigateToLocation: this.navigateHeadless.bind(this),
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
      removeLiveComment: this.removeHeadlessLiveComment.bind(this),
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
      this.reviewState = createReviewCommandState({
        files: bootstrap.changeset.files,
        initialShowAgentNotes: bootstrap.initialShowAgentNotes ?? false,
      });
      this.sessionSnapshot = this.buildSessionSnapshot(bootstrap);
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

  /** Build the broker-facing snapshot from the current command state. */
  private buildSessionSnapshot(bootstrap = this.renderSnapshot.bootstrap) {
    return buildReviewSessionSnapshot({
      files: bootstrap.changeset.files,
      state: this.reviewState,
      now: new Date().toISOString(),
    });
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
    this.reviewState = createReviewCommandState({
      files: this.renderSnapshot.bootstrap.changeset.files,
      initialSessionState: snapshot.state,
    });
  }

  /** Publish the current session-owned review state to the daemon. */
  private updateHeadlessSnapshot() {
    this.sessionSnapshot = this.buildSessionSnapshot();
    this.brokerClient.updateSnapshot(this.sessionSnapshot);
    for (const listener of this.listeners) listener();
  }

  /** Apply a headless review-state transition and publish it to the daemon. */
  private applyHeadlessTransition<T>(transition: { state: ReviewCommandState; result: T }): T {
    this.reviewState = transition.state;
    this.updateHeadlessSnapshot();
    return transition.result;
  }

  /** Update the persisted agent-note visibility bit. */
  private setHeadlessAgentNotesVisible(visible: boolean) {
    this.reviewState = setReviewAgentNotesVisible(this.reviewState, visible);
    this.updateHeadlessSnapshot();
  }

  /** Add one live agent comment to the session-owned review state. */
  private addHeadlessLiveComment(
    input: Extract<HunkSessionServerMessage, { command: "comment" }>["input"],
    commentId: string,
    options?: { reveal?: boolean },
  ): AppliedCommentResult {
    return this.applyHeadlessTransition(
      addReviewLiveComment({
        files: this.renderSnapshot.bootstrap.changeset.files,
        state: this.reviewState,
        input,
        commentId,
        now: new Date().toISOString(),
        options,
      }),
    );
  }

  /** Apply a validated batch of live comments to the session-owned review state. */
  private addHeadlessLiveCommentBatch(
    inputs: Extract<HunkSessionServerMessage, { command: "comment_batch" }>["input"]["comments"],
    requestId: string,
    options?: { revealMode?: "none" | "first" },
  ): AppliedCommentBatchResult {
    return this.applyHeadlessTransition(
      addReviewLiveCommentBatch({
        files: this.renderSnapshot.bootstrap.changeset.files,
        state: this.reviewState,
        inputs,
        requestId,
        now: new Date().toISOString(),
        options,
      }),
    );
  }

  /** Navigate the persisted hidden-session selection. */
  private navigateHeadless(
    input: Extract<HunkSessionServerMessage, { command: "navigate_to_hunk" }>["input"],
  ): NavigatedSelectionResult {
    const files = reviewCommandFiles(
      this.renderSnapshot.bootstrap.changeset.files,
      this.reviewState,
    );
    return this.applyHeadlessTransition(
      navigateReviewCommandState({
        allFiles: files,
        visibleFiles: files,
        state: this.reviewState,
        input,
      }),
    );
  }

  /** Remove one persisted live comment. */
  private removeHeadlessLiveComment(commentId: string): RemovedCommentResult {
    return this.applyHeadlessTransition(removeReviewLiveComment(this.reviewState, commentId));
  }

  /** Clear persisted live comments, optionally scoped to one file. */
  private clearHeadlessLiveComments(filePath?: string): ClearedCommentsResult {
    return this.applyHeadlessTransition(
      clearReviewLiveComments({
        files: this.renderSnapshot.bootstrap.changeset.files,
        state: this.reviewState,
        filePath,
      }),
    );
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

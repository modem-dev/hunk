import { canReloadInput } from "../core/inputReload";
import { SourceTextTooLargeError } from "../core/fileSource";
import { buildLiveComment, findDiffFileByPath, resolveCommentTarget } from "../core/liveComments";
import { resolveConfiguredCliInput } from "../core/config";
import { resolveExperimentalDiffFiles } from "../core/experimental";
import { projectReviewDocument } from "../core/review/document";
import { reviewGapAddress } from "../core/review/expansion";
import { reviewDigest } from "../core/review/identity";
import { projectReviewNote } from "../core/review/notes";
import { parseStml } from "../core/review/stml";
import { reviewFileMatchesFilter } from "../core/review/selectors";
import { reconcileReviewState, reviewLineContextDigest } from "../core/review/reconcile";
import { reviewInputSourceIdentity } from "../core/review/sourceIdentity";
import {
  createReviewStore,
  createReviewStoreFromState,
  prepareReviewState,
  type ReviewStore,
} from "../core/review/store";
import type { ReviewAction } from "../core/review/actions";
import type { ReviewState, ReviewStoredNote } from "../core/review/state";
import type {
  ReviewDocumentProjectionV1,
  ReviewFileV1,
  ReviewSourceResourceDescriptorV1,
} from "../core/review/types";
import { resolveRuntimeCliInput } from "../core/terminal";
import type { AppBootstrap, CliInput } from "../core/types";
import { createUnknownVcsNotice, reportExtensionApplyIssues } from "../extensions/apply";
import {
  emitExtensionEvent,
  emitExtensionEventBounded,
  emitExtensionEventToExtensions,
} from "../extensions/events";
import { loadStartupExtensions } from "../extensions/startup";
import { writeExtensionTrust, type ExtensionTrustDecision } from "../extensions/trust";
import type { ExtensionLoadResult, SessionReloadReason } from "../extensions/types";
import {
  assertSessionRegistrationEnvelopeWithinBounds,
  createHunkReviewManifest,
  updateSessionRegistration,
} from "../session/app/registration";
import {
  createHunkReviewState,
  createSessionSnapshotFromReviewState,
  type SessionRendererSnapshotFields,
} from "../session/app/reviewSnapshot";
import {
  MAX_REVIEW_SOURCE_RESOURCE_BYTES,
  REVIEW_RESOURCE_CHUNK_BYTES,
  assertReviewProducerEnvelopeWithinBounds,
  parseApplyReviewActionInput,
  parseGetReviewSnapshotInput,
  parseReadReviewResourceInput,
  type ApplyReviewActionInput,
  type GetReviewSnapshotInput,
  type HunkReviewActionV1,
  type ReadReviewResourceInput,
  type ReviewCommandErrorResult,
  type HunkReviewCommandResult,
} from "../session/reviewProtocol";
import {
  createSessionReloadBounds,
  validateSessionReloadWithinBounds,
  type SessionReloadBounds,
} from "../session/app/reloadBounds";
import type {
  HunkSessionBrokerClient,
  HunkSessionCommandResult,
  HunkSessionServerMessage,
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  ReloadSessionOptions,
  RemovedCommentResult,
} from "../session/types";
import { loadConfiguredSessionBootstrap, type SessionBootstrapResult } from "./sessionBootstrap";
import { createWatchedInputController, type WatchedInputRuntime } from "./watchRuntime";
import type { WatchController } from "../core/watchController";
import {
  allowsUnsafeRemoteSessionBroker,
  isLoopbackHost,
  resolveSessionBrokerConfig,
} from "../session/broker/brokerConfig";
import { parseTailscaleBrowserOrigin } from "../session/tailscale";
import {
  buildBrowserReviewUrl,
  createBrowserReviewCapability,
  openBrowserUrl,
} from "./browserReview";

export interface ReviewSessionTrustState {
  pendingRepoRoot: string | null;
  promptRepoRoot: string | null;
}

export interface ReviewSessionRuntimeSnapshot {
  revision: number;
  bootstrap: AppBootstrap;
  projection: ReviewDocumentProjectionV1;
  store: ReviewStore;
  extensions?: ExtensionLoadResult;
  trust: ReviewSessionTrustState;
  notice: string | null;
  remountVersion: number;
}

export interface ReviewSessionRuntimeDeps {
  resolveRuntimeCliInputImpl?: typeof resolveRuntimeCliInput;
  resolveConfiguredCliInputImpl?: typeof resolveConfiguredCliInput;
  loadConfiguredSessionBootstrapImpl?: typeof loadConfiguredSessionBootstrap;
  loadStartupExtensionsImpl?: typeof loadStartupExtensions;
  writeExtensionTrustImpl?: typeof writeExtensionTrust;
}

export interface ReviewSessionRuntimeOptions {
  hostClient?: HunkSessionBrokerClient;
  /** Raw launch invocation, before config defaults were applied. */
  rawInput?: CliInput;
  watchRuntime?: WatchedInputRuntime;
  deps?: ReviewSessionRuntimeDeps;
}

interface QueuedReload {
  epoch: number;
  reason: SessionReloadReason;
  input: CliInput;
  options: ReloadSessionOptions;
  resolve: (result: ReloadedSessionResult) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

interface PreparedReload {
  epoch: number;
  reason: SessionReloadReason;
  options: ReloadSessionOptions;
  cwd: string;
  prepared: SessionBootstrapResult;
  extensions?: ExtensionLoadResult;
  reloadedExtensions: boolean;
  previouslyLoadedIds: Set<string>;
}

type AppliedSessionCommentResult = AppliedCommentResult | AppliedCommentBatchResult;

type CachedSessionCommentResult =
  | { command: "comment"; requestId: string; result: AppliedCommentResult }
  | { command: "comment_batch"; requestId: string; result: AppliedCommentBatchResult };

const MAX_SESSION_COMMENT_RESULTS = 256;

/** Project the renderer-neutral generation and all of its materialized resources. */
function projectBootstrap(bootstrap: AppBootstrap, generation: string) {
  const files = resolveExperimentalDiffFiles(bootstrap.changeset.files, bootstrap.input.options);
  return projectReviewDocument(
    { ...bootstrap.changeset, files },
    {
      generation,
      sourceIdentity: reviewInputSourceIdentity(bootstrap.input, bootstrap.reloadContext),
    },
  );
}

/** Own one authoritative review session without importing a renderer or React. */
export class ReviewSessionRuntime {
  private snapshot: ReviewSessionRuntimeSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly reloadBounds: SessionReloadBounds;
  private hostClient?: HunkSessionBrokerClient;
  private readonly watchRuntime?: WatchedInputRuntime;
  private readonly deps: Required<ReviewSessionRuntimeDeps>;
  private readonly rawInput: CliInput;
  private readonly launchExperimental: boolean;
  private readonly launchExtensionsEnabled: boolean | undefined;
  private readonly launchExtensionPaths: string[] | undefined;
  private readonly offeredTrustRepoRoots = new Set<string>();
  private readonly startedExtensionIds = new Set<string>();
  private readonly closedExtensionResults = new WeakSet<ExtensionLoadResult>();
  private readonly preparingExtensionResults = new Map<number, ExtensionLoadResult>();
  private extensionsCwd: string;
  private rendererFields: SessionRendererSnapshotFields = {};
  private watchController: WatchController | null = null;
  private storeSubscription: (() => void) | null = null;
  private reloadQueue: QueuedReload[] = [];
  private supersededReloads: QueuedReload[] = [];
  private activeReload: QueuedReload | null = null;
  private processingReloads = false;
  private reloadEpochSequence = 0;
  private latestRequestedEpoch = 0;
  private generationSequence = 0;
  private userNoteSequence = 0;
  private readonly sessionCommentIds = new Map<string, string>();
  private readonly sessionCommentResults = new Map<string, CachedSessionCommentResult>();
  private readonly sourceLoads = new Map<string, Promise<void>>();
  private asynchronousActionReservation:
    | { generation: string; stateRevision: number; token: symbol }
    | undefined;
  private started = false;
  private disposed = false;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly browserReviewCapability = createBrowserReviewCapability();

  constructor(bootstrap: AppBootstrap, options: ReviewSessionRuntimeOptions = {}) {
    this.watchRuntime = options.watchRuntime;
    this.deps = {
      resolveRuntimeCliInputImpl:
        options.deps?.resolveRuntimeCliInputImpl ?? resolveRuntimeCliInput,
      resolveConfiguredCliInputImpl:
        options.deps?.resolveConfiguredCliInputImpl ?? resolveConfiguredCliInput,
      loadConfiguredSessionBootstrapImpl:
        options.deps?.loadConfiguredSessionBootstrapImpl ?? loadConfiguredSessionBootstrap,
      loadStartupExtensionsImpl: options.deps?.loadStartupExtensionsImpl ?? loadStartupExtensions,
      writeExtensionTrustImpl: options.deps?.writeExtensionTrustImpl ?? writeExtensionTrust,
    };
    this.rawInput = options.rawInput ?? bootstrap.input;
    this.launchExperimental = this.rawInput.options.experimental === true;
    this.launchExtensionsEnabled = this.rawInput.options.extensions;
    this.launchExtensionPaths = this.rawInput.options.extensionPaths;
    this.reloadBounds = createSessionReloadBounds(bootstrap, { cwd: bootstrap.reloadContext.cwd });
    this.extensionsCwd = this.reloadBounds.defaultCwd;
    const projection = projectBootstrap(bootstrap, "generation:runtime:0");
    const pendingRepoRoot = bootstrap.extensions?.pendingTrustRepoRoot ?? null;
    const promptRepoRoot = bootstrap.input.options.pager ? null : pendingRepoRoot;
    const store = createReviewStore(projection.document, {
      showAgentNotes: bootstrap.initialShowAgentNotes ?? false,
      trustPromptRepoRoot: promptRepoRoot,
      validateNextSnapshot: (next) => this.validateReviewStoreSnapshot(next),
    });
    if (promptRepoRoot) this.offeredTrustRepoRoots.add(promptRepoRoot);
    this.snapshot = {
      revision: 0,
      bootstrap,
      projection,
      store,
      extensions: bootstrap.extensions,
      trust: { pendingRepoRoot, promptRepoRoot },
      notice: null,
      remountVersion: 0,
    };
    this.bindStore(store);
    if (options.hostClient) this.attachHostClient(options.hostClient);
  }

  /** Attach the producer transport after constructing its authoritative initial registration. */
  attachHostClient(hostClient: HunkSessionBrokerClient) {
    if (this.disposed) return;
    this.hostClient = hostClient;
    hostClient.setBridge({ dispatchCommand: (message) => this.dispatchSessionCommand(message) });
  }

  /** Read the atomically published runtime generation. */
  getSnapshot = () => this.snapshot;

  /** Subscribe to generation, trust, and notice publications. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Return only the verifier that may cross the producer-to-broker boundary. */
  getBrowserReviewCapabilityHash() {
    return this.browserReviewCapability.hash;
  }

  /** Build the safe local review URL while keeping the clear capability process-local. */
  getBrowserReviewUrl(origin?: string) {
    if (process.env.HUNK_MCP_DISABLE === "1") {
      throw new Error("Browser review is unavailable because HUNK_MCP_DISABLE is set.");
    }
    const config = resolveSessionBrokerConfig();
    if (!isLoopbackHost(config.host) || allowsUnsafeRemoteSessionBroker()) {
      throw new Error("Browser review requires Hunk's safe loopback session daemon.");
    }
    const sessionId = this.hostClient?.getRegistration().sessionId;
    if (!sessionId) throw new Error("Review session is not attached to the local broker.");
    const browserOrigin = origin ?? config.httpOrigin;
    if (
      browserOrigin !== config.httpOrigin &&
      !parseTailscaleBrowserOrigin(browserOrigin, config.port)
    ) {
      throw new Error("Browser review origin was not issued by the local or Tailscale daemon.");
    }
    return buildBrowserReviewUrl(browserOrigin, sessionId, this.browserReviewCapability.capability);
  }

  /** Open this runtime's browser review using the shared shell-free platform opener. */
  openBrowserReview(origin?: string) {
    return openBrowserUrl(this.getBrowserReviewUrl(origin));
  }

  /** Expose immutable launch-scoped reload roots for diagnostics and tests. */
  getReloadBounds() {
    return { roots: [...this.reloadBounds.roots], defaultCwd: this.reloadBounds.defaultCwd };
  }

  /** Resolve one materialized resource only from the active generation. */
  getResource(resourceId: string) {
    const descriptor = this.snapshot.projection.document.resources.find(
      (resource) => resource.id === resourceId,
    );
    if (!descriptor) throw new Error(`Unknown or retired review resource ${resourceId}.`);
    return this.snapshot.projection.resourceContents[resourceId];
  }

  /** Begin lifecycle events and watch observation after an adapter has mounted. */
  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    const extensions = this.snapshot.extensions;
    for (const { id } of extensions?.loaded ?? []) this.startedExtensionIds.add(id);
    emitExtensionEvent(extensions, "startup", { cwd: this.snapshot.bootstrap.reloadContext.cwd });
    this.restartWatch();
  }

  /** Update terminal-only fields used when mirroring semantic state to the broker. */
  setSessionRendererFields(fields: SessionRendererSnapshotFields) {
    this.rendererFields = fields;
    this.publishBrokerSnapshot(this.snapshot.store);
  }

  /** Queue every reload trigger through one ordered executor. */
  reload(
    reason: SessionReloadReason,
    input: CliInput = this.snapshot.bootstrap.input,
    options: ReloadSessionOptions = {},
  ): Promise<ReloadedSessionResult> {
    if (this.disposed) return Promise.reject(new Error("Review session runtime is disposed."));
    const epoch = ++this.reloadEpochSequence;
    const requiredExtensionReloadPending =
      options.reloadExtensions !== true &&
      (this.activeReload?.options.reloadExtensions === true ||
        this.reloadQueue.some((request) => request.options.reloadExtensions === true));
    if (!requiredExtensionReloadPending) this.latestRequestedEpoch = epoch;
    return new Promise((resolve, reject) => {
      this.reloadQueue.push({
        epoch,
        reason,
        input,
        options: { ...options, reason },
        resolve,
        reject,
        settled: false,
      });
      void this.processReloadQueue();
    });
  }

  /** Toggle one canonical collapsed gap and let the runtime own generation-safe source loading. */
  toggleSourceGap(fileKey: string, gapId: string) {
    const state = this.snapshot.store.getSnapshot();
    return this.toggleSourceGapForState(
      fileKey,
      gapId,
      state.documentGeneration,
      state.stateRevision,
    );
  }

  /** Dismiss the current trust question without persisting a decision. */
  dismissTrustPrompt() {
    if (!this.snapshot.trust.promptRepoRoot) return;
    const state = this.snapshot.store.getSnapshot();
    this.commitReviewActions([
      {
        type: "trust/set-prompt",
        expectedGeneration: state.documentGeneration,
        repoRoot: null,
      },
    ]);
    this.publishMetadata({
      trust: { ...this.snapshot.trust, promptRepoRoot: null },
    });
  }

  /** Persist trust and clear its prompt only after any required extension reload succeeds. */
  async decideExtensionTrust(decision: ExtensionTrustDecision) {
    const repoRoot = this.snapshot.trust.promptRepoRoot;
    if (!repoRoot) return;
    try {
      this.deps.writeExtensionTrustImpl(repoRoot, decision);
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Failed to record the trust decision.");
      this.showNotice(failure.message);
      throw failure;
    }

    if (canReloadInput(this.snapshot.bootstrap.input)) {
      try {
        await this.reload("manual", this.rawInput, {
          resetApp: false,
          reloadExtensions: true,
          sourcePath: this.currentSourcePath(),
        });
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error("Failed to reload repository extensions.");
        this.showNotice(
          decision === "denied"
            ? "Denied repository extensions, but failed to refresh the review."
            : "Failed to reload after trusting this repository's extensions.",
        );
        throw failure;
      }
      if (decision === "denied") this.showNotice("Won't run this repository's extensions");
      return;
    }

    const state = this.snapshot.store.getSnapshot();
    this.commitReviewActions([
      {
        type: "trust/set-prompt",
        expectedGeneration: state.documentGeneration,
        repoRoot: null,
      },
    ]);
    this.publishMetadata({ trust: { ...this.snapshot.trust, promptRepoRoot: null } });
    this.showNotice(
      decision === "denied"
        ? "Won't run this repository's extensions"
        : "Trusted this repository • restart Hunk to load its extensions",
    );
  }

  /** Emit bounded shutdown and release observers and queued work. */
  async shutdown() {
    await emitExtensionEventBounded(this.snapshot.extensions, "shutdown", {});
    this.dispose();
  }

  /** Dispose watchers, timers, extension buses, and unresolved reload callers. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.asynchronousActionReservation = undefined;
    this.sessionCommentIds.clear();
    this.sessionCommentResults.clear();
    this.watchController?.close();
    this.watchController = null;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    const error = new Error("Review session runtime is disposed.");
    for (const request of [
      ...(this.activeReload ? [this.activeReload] : []),
      ...this.reloadQueue,
      ...this.supersededReloads,
    ]) {
      this.rejectReload(request, error);
    }
    this.reloadQueue = [];
    this.supersededReloads = [];
    this.retireStoreAndCommandAuthority();
    this.closeExtensionResult(this.snapshot.extensions);
    for (const extensions of this.preparingExtensionResults.values()) {
      this.closeExtensionResult(extensions);
    }
    this.listeners.clear();
  }

  /** Process reload preparation serially and publish only the newest requested epoch. */
  private async processReloadQueue() {
    if (this.processingReloads) return;
    this.processingReloads = true;
    try {
      while (!this.disposed && this.reloadQueue.length > 0) {
        const request = this.reloadQueue.shift()!;
        if (request.epoch !== this.latestRequestedEpoch) {
          this.supersededReloads.push(request);
          continue;
        }
        this.activeReload = request;
        let prepared: PreparedReload | undefined;
        try {
          prepared = await this.prepareReload(request);
          if (this.disposed) {
            if (prepared.reloadedExtensions) this.closeExtensionResult(prepared.extensions);
            this.rejectReload(request, new Error("Review session runtime is disposed."));
            continue;
          }
          if (request.epoch !== this.latestRequestedEpoch) {
            if (prepared.reloadedExtensions) this.closeExtensionResult(prepared.extensions);
            this.supersededReloads.push(request);
            continue;
          }
          const result = this.publishReload(prepared);
          this.resolveReload(request, result);
          for (const superseded of this.supersededReloads.splice(0)) {
            this.resolveReload(superseded, result);
          }
        } catch (error) {
          if (prepared?.reloadedExtensions && prepared.extensions !== this.snapshot.extensions) {
            this.closeExtensionResult(prepared.extensions);
          }
          if (request.epoch !== this.latestRequestedEpoch) {
            this.supersededReloads.push(request);
            continue;
          }
          this.rejectReload(request, error);
          for (const superseded of this.supersededReloads.splice(0)) {
            this.rejectReload(superseded, error);
          }
        } finally {
          this.preparingExtensionResults.delete(request.epoch);
          if (this.activeReload === request) this.activeReload = null;
          // Weaker reloads queued behind a required extension refresh compete only after it settles.
          if (request.epoch === this.latestRequestedEpoch && this.reloadQueue.length > 0) {
            this.latestRequestedEpoch = this.reloadQueue.at(-1)!.epoch;
          }
        }
      }
    } finally {
      this.processingReloads = false;
      if (!this.disposed && this.reloadQueue.length > 0) void this.processReloadQueue();
    }
  }

  /** Run canonical config, extension discovery, VCS resolution, loading, and transforms. */
  private async prepareReload(request: QueuedReload): Promise<PreparedReload> {
    // Local refreshes reapply config to the launch invocation. Daemon requests are new,
    // explicit invocations and therefore remain authoritative for their own source/options.
    const requestedInput = request.reason === "daemon" ? request.input : this.rawInput;
    const launchOverrides = {
      experimental: this.launchExperimental,
      ...(this.launchExtensionsEnabled !== undefined
        ? { extensions: this.launchExtensionsEnabled }
        : {}),
      ...(this.launchExtensionPaths !== undefined
        ? { extensionPaths: this.launchExtensionPaths }
        : {}),
    };
    const runtimeInput = this.deps.resolveRuntimeCliInputImpl({
      ...requestedInput,
      options: {
        ...requestedInput.options,
        ...launchOverrides,
      },
    });
    const { cwd } = validateSessionReloadWithinBounds(this.reloadBounds, runtimeInput, {
      sourcePath: request.options.sourcePath,
    });
    const configured = this.deps.resolveConfiguredCliInputImpl(runtimeInput, { cwd });
    const activeExtensions = this.snapshot.extensions;
    const previouslyLoadedIds = new Set(
      (activeExtensions?.loaded ?? []).map((extension) => extension.id),
    );
    const reloadedExtensions = Boolean(
      request.options.reloadExtensions || cwd !== this.extensionsCwd,
    );
    const extensions = reloadedExtensions
      ? await this.deps.loadStartupExtensionsImpl({
          extensions: configured.extensions,
          cwd,
          cliExtensionPaths: configured.input.options.extensionPaths,
          notifications: activeExtensions?.notifications,
        })
      : activeExtensions;
    if (reloadedExtensions && extensions) {
      // Discovery transfers a fresh registry to runtime ownership before transforms begin. A
      // transform may never settle, so dispose must not need to wait for prepareReload to return.
      this.preparingExtensionResults.set(request.epoch, extensions);
      if (this.disposed) {
        this.closeExtensionResult(extensions);
        throw new Error("Review session runtime is disposed.");
      }
    }
    let prepared: SessionBootstrapResult;
    try {
      prepared = await this.deps.loadConfiguredSessionBootstrapImpl({
        configured,
        cwd,
        extensions,
        loadAtCwd: true,
      });
    } catch (error) {
      if (reloadedExtensions) this.closeExtensionResult(extensions);
      throw error;
    }
    prepared.bootstrap.startupNotices =
      prepared.sessionVcs.unknownVcsId !== undefined
        ? [
            ...(configured.startupNotices ?? []),
            createUnknownVcsNotice(
              prepared.sessionVcs.unknownVcsId,
              String(prepared.input.options.vcs),
            ),
          ]
        : configured.startupNotices;
    return {
      epoch: request.epoch,
      reason: request.reason,
      options: request.options,
      cwd,
      prepared,
      extensions,
      reloadedExtensions,
      previouslyLoadedIds,
    };
  }

  /** Preflight a complete candidate before atomically replacing the live session generation. */
  private publishReload(reload: PreparedReload): ReloadedSessionResult {
    const { applied } = reload.prepared;
    const bootstrap: AppBootstrap = {
      ...reload.prepared.bootstrap,
      extensions: reload.extensions,
    };
    const nextGenerationSequence = this.generationSequence + 1;
    const projection = projectBootstrap(bootstrap, `generation:runtime:${nextGenerationSequence}`);
    const previousSnapshot = this.snapshot;
    const previousState = previousSnapshot.store.getSnapshot();
    let store =
      reload.options.resetApp === false
        ? createReviewStoreFromState(
            {
              ...reconcileReviewState(previousState, projection.document),
              stateRevision: previousState.stateRevision + 1,
            },
            { validateNextSnapshot: (next) => this.validateReviewStoreSnapshot(next) },
          )
        : createReviewStore(projection.document, {
            showAgentNotes: bootstrap.initialShowAgentNotes ?? false,
            validateNextSnapshot: (next) => this.validateReviewStoreSnapshot(next),
          });
    const pendingRepoRoot = reload.extensions?.pendingTrustRepoRoot ?? null;
    const promptRepoRoot =
      !bootstrap.input.options.pager &&
      pendingRepoRoot &&
      !this.offeredTrustRepoRoots.has(pendingRepoRoot)
        ? pendingRepoRoot
        : null;
    if (store.getSnapshot().trustPromptRepoRoot !== promptRepoRoot) {
      store = createReviewStoreFromState(
        { ...store.getSnapshot(), trustPromptRepoRoot: promptRepoRoot },
        { validateNextSnapshot: (next) => this.validateReviewStoreSnapshot(next) },
      );
    }
    const nextSnapshot: ReviewSessionRuntimeSnapshot = {
      revision: previousSnapshot.revision + 1,
      bootstrap,
      projection,
      store,
      extensions: reload.extensions,
      trust: { pendingRepoRoot, promptRepoRoot },
      notice: previousSnapshot.notice,
      remountVersion: previousSnapshot.remountVersion + (reload.options.resetApp === false ? 0 : 1),
    };
    const nextSessionSnapshot = createSessionSnapshotFromReviewState(
      store.getSnapshot(),
      this.rendererFields,
    );
    const nextRegistration = this.hostClient
      ? updateSessionRegistration(this.hostClient.getRegistration(), bootstrap, projection.document)
      : null;
    if (nextRegistration) {
      assertSessionRegistrationEnvelopeWithinBounds(nextRegistration, nextSessionSnapshot);
    }
    const sessionId = nextRegistration?.sessionId ?? "local-session";
    const result = {
      sessionId,
      inputKind: bootstrap.input.kind,
      title: bootstrap.changeset.title,
      sourceLabel: bootstrap.changeset.sourceLabel,
      fileCount: bootstrap.changeset.files.length,
      selectedFilePath: nextSessionSnapshot.state.selectedFilePath,
      selectedHunkIndex: nextSessionSnapshot.state.selectedHunkIndex,
    } satisfies ReloadedSessionResult;
    this.assertCommandResultWithinBounds(result, "Reload result");
    this.assertCommandResultWithinBounds(
      {
        kind: "review-snapshot",
        generation: projection.document.generation,
        manifest: createHunkReviewManifest(bootstrap, projection.document),
        state: createHunkReviewState(store.getSnapshot()),
      },
      "Review reconnect snapshot",
    );
    if (this.disposed) throw new Error("Review session runtime is disposed.");

    // No active authority, registry, trust history, watch, or broker state changes before here.
    this.retireStoreAndCommandAuthority();
    if (this.disposed) throw new Error("Review session runtime is disposed.");
    this.generationSequence = nextGenerationSequence;
    this.snapshot = nextSnapshot;
    if (reload.reloadedExtensions) this.extensionsCwd = reload.cwd;
    if (promptRepoRoot) this.offeredTrustRepoRoots.add(promptRepoRoot);
    if (reload.reloadedExtensions && previousSnapshot.extensions !== reload.extensions) {
      this.closeExtensionResult(previousSnapshot.extensions);
    }
    if (this.hostClient && nextRegistration) {
      this.hostClient.replaceSession(nextRegistration, nextSessionSnapshot);
      this.hostClient.setBridge({
        dispatchCommand: (message) => this.dispatchSessionCommand(message),
      });
    }
    if (this.disposed) return result;

    this.bindStore(store);
    if (this.disposed) return result;
    if (reload.extensions) reportExtensionApplyIssues(applied.issues, reload.extensions.context);
    this.notify();
    if (this.disposed) return result;
    if (this.started) this.restartWatch();
    if (this.disposed) return result;

    if (reload.reloadedExtensions) {
      const newlyLoadedIds = new Set(
        (reload.extensions?.loaded ?? [])
          .map((extension) => extension.id)
          .filter((id) => !reload.previouslyLoadedIds.has(id) && !this.startedExtensionIds.has(id)),
      );
      for (const id of newlyLoadedIds) this.startedExtensionIds.add(id);
      emitExtensionEventToExtensions(
        reload.extensions,
        "startup",
        { cwd: reload.cwd },
        newlyLoadedIds,
      );
      if (this.disposed) return result;
    }
    emitExtensionEvent(reload.extensions, "session_reload", {
      changeset: bootstrap.changeset,
      reason: reload.reason,
    });
    return result;
  }

  /** Restart watch planning against the just-published input, context, and adapters. */
  private restartWatch() {
    if (this.disposed) return;
    this.watchController?.close();
    this.watchController = null;
    if (this.disposed) return;
    const { bootstrap, extensions } = this.snapshot;
    if (!bootstrap.input.options.watch || !canReloadInput(bootstrap.input)) return;
    const nextWatchController = createWatchedInputController({
      input: bootstrap.input,
      reloadContext: bootstrap.reloadContext,
      runtime: this.watchRuntime,
      onReloadPending: () => emitExtensionEvent(extensions, "watch_reload_pending", {}),
      refresh: async () => {
        await this.reload("watch", this.rawInput, {
          resetApp: false,
          sourcePath: this.currentSourcePath(),
        });
      },
    });
    if (this.disposed) {
      nextWatchController?.close();
      return;
    }
    this.watchController = nextWatchController;
  }

  /** Return the working directory label used by reload bounds for VCS inputs. */
  private currentSourcePath() {
    const { bootstrap } = this.snapshot;
    return bootstrap.input.kind === "vcs" ||
      bootstrap.input.kind === "show" ||
      bootstrap.input.kind === "stash-show"
      ? bootstrap.changeset.sourceLabel
      : undefined;
  }

  /** Close one retired extension registry exactly once. */
  private closeExtensionResult(extensions: ExtensionLoadResult | undefined) {
    if (!extensions || this.closedExtensionResults.has(extensions)) return;
    this.closedExtensionResults.add(extensions);
    extensions.registry.emitCustomEvent = undefined;
    extensions.registry.eventBusPhase = "closed";
    extensions.registry.pendingCustomEvents.length = 0;
  }

  /** Publish a semantic snapshot only for the currently bound store generation. */
  private publishBrokerSnapshot(store: ReviewStore) {
    if (this.disposed || store !== this.snapshot.store) return;
    this.hostClient?.updateSnapshot(
      createSessionSnapshotFromReviewState(store.getSnapshot(), this.rendererFields),
    );
  }

  /** Subscribe broker publication directly to the active renderer-neutral store. */
  private bindStore(store: ReviewStore) {
    this.storeSubscription = store.subscribe(() => this.publishBrokerSnapshot(store));
    this.publishBrokerSnapshot(store);
  }

  /** Retire both semantic publication and command mutation authority before generation cutover. */
  private retireStoreAndCommandAuthority() {
    this.storeSubscription?.();
    this.storeSubscription = null;
    this.hostClient?.setBridge(null);
  }

  /** Return a typed protocol failure without collapsing conflicts into transport strings. */
  private reviewCommandError(
    code: ReviewCommandErrorResult["error"]["code"],
    message: string,
  ): ReviewCommandErrorResult {
    return {
      kind: "review-error",
      error: {
        code,
        message,
        currentGeneration: this.snapshot.store.getSnapshot().documentGeneration,
      },
    };
  }

  /** Verify a command targets this producer and its currently published generation. */
  private validateReviewCommandTarget(sessionId: string, generation: string) {
    const currentSessionId = this.hostClient?.getRegistration().sessionId;
    if (!currentSessionId || sessionId !== currentSessionId) {
      return this.reviewCommandError("cross-session", "Review command targets another session.");
    }
    const currentGeneration = this.snapshot.store.getSnapshot().documentGeneration;
    if (generation !== currentGeneration) {
      return this.reviewCommandError(
        "stale-generation",
        `Review generation ${generation} is retired; current generation is ${currentGeneration}.`,
      );
    }
    return null;
  }

  /** Read one bounded byte range only from a fully described active resource. */
  private readReviewResource(input: ReadReviewResourceInput): HunkReviewCommandResult {
    if (typeof input.generation !== "string" || input.generation.length === 0) {
      return this.reviewCommandError("invalid-generation", "Resource generation is required.");
    }
    const targetError = this.validateReviewCommandTarget(input.sessionId, input.generation);
    if (targetError) return targetError;
    if (
      !Number.isInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isInteger(input.length) ||
      input.length <= 0 ||
      input.length > REVIEW_RESOURCE_CHUNK_BYTES
    ) {
      return this.reviewCommandError(
        "invalid-range",
        `Resource reads require a non-negative offset and length from 1 to ${REVIEW_RESOURCE_CHUNK_BYTES}.`,
      );
    }

    const descriptor = this.snapshot.projection.document.resources.find(
      (resource) => resource.id === input.resourceId,
    );
    const text = this.snapshot.projection.resourceContents[input.resourceId];
    if (
      !descriptor ||
      descriptor.byteLength === undefined ||
      !descriptor.digest ||
      text === undefined
    ) {
      return this.reviewCommandError(
        "unknown-resource",
        `Review resource ${input.resourceId} has no bounded materialized descriptor.`,
      );
    }
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength !== descriptor.byteLength) {
      return this.reviewCommandError("unknown-resource", "Resource content size is inconsistent.");
    }
    if (input.offset > descriptor.byteLength) {
      return this.reviewCommandError("invalid-range", "Resource offset is outside its content.");
    }
    const end = Math.min(bytes.byteLength, input.offset + input.length);
    const chunk = bytes.subarray(input.offset, end);
    return {
      kind: "review-resource",
      generation: input.generation,
      id: input.resourceId,
      resourceId: input.resourceId,
      offset: input.offset,
      byteLength: chunk.byteLength,
      encoding: "base64",
      data: chunk.toString("base64"),
      contentDigest: descriptor.digest,
      contentSize: descriptor.byteLength,
      eof: end === bytes.byteLength,
    };
  }

  /** Return whether a JSON object has exactly the allowed keys for one action variant. */
  private hasExactKeys(record: Record<string, unknown>, allowed: readonly string[]) {
    const keys = Object.keys(record);
    return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
  }

  /** Resolve the active terminal file and semantic file through the generation projection. */
  private reviewFilePair(fileKey: string) {
    const semantic = this.snapshot.projection.document.files.find((file) => file.key === fileKey);
    const file = semantic
      ? this.snapshot.bootstrap.changeset.files.find(
          (candidate) => candidate.id === semantic.runtimeId,
        )
      : undefined;
    return semantic && file ? { semantic, file } : null;
  }

  /** Retain independent reload evidence for every side range of one mutable note. */
  private mutableNoteDigests(
    file: ReviewFileV1,
    ranges: { oldRange?: readonly [number, number]; newRange?: readonly [number, number] },
  ) {
    return {
      ...(ranges.oldRange ? { old: reviewLineContextDigest(file, "old", ranges.oldRange[0]) } : {}),
      ...(ranges.newRange ? { new: reviewLineContextDigest(file, "new", ranges.newRange[0]) } : {}),
    };
  }

  /** Validate every prospective store revision against its broker snapshot envelope. */
  private validateReviewStoreSnapshot(next: ReviewState) {
    const snapshot = createSessionSnapshotFromReviewState(next, this.rendererFields);
    assertReviewProducerEnvelopeWithinBounds(
      { type: "snapshot", snapshot },
      "Review snapshot update",
    );
  }

  /** Preflight one producer command result with conservative websocket framing. */
  private assertCommandResultWithinBounds(result: unknown, label: string) {
    assertReviewProducerEnvelopeWithinBounds(
      {
        type: "command-result",
        requestId: "00000000-0000-0000-0000-000000000000",
        ok: true,
        result,
      },
      label,
    );
  }

  /** Preflight broker projections and atomically publish one logical review mutation. */
  private commitReviewActions(actions: readonly ReviewAction[], includeActionResult = false) {
    const store = this.snapshot.store;
    const before = store.getSnapshot();
    const next = prepareReviewState(before, actions);
    if (next === before) return next;
    if (includeActionResult) {
      const result = {
        kind: "review-action" as const,
        generation: next.documentGeneration,
        stateRevision: next.stateRevision,
        state: createHunkReviewState(next),
      };
      this.assertCommandResultWithinBounds(result, "Review action result");
    }
    return store.commitPrepared(before, next);
  }

  /** Validate optional STML at the terminal's live width while preserving safe degradation notes. */
  private reviewMarkupFeedback(markup: string | undefined) {
    if (markup === undefined || markup.length === 0) return {};
    if (!this.snapshot.bootstrap.input.options.experimental) {
      throw new Error(
        "STML markup is disabled for this session. Relaunch Hunk with --experimental, or omit markup.",
      );
    }
    const markupWidth = this.rendererFields.noteMarkupWidth ?? 56;
    const markupNotes = this.rendererFields.validateMarkup
      ? this.rendererFields.validateMarkup(markup, markupWidth)
      : parseStml(markup).errors;
    return {
      markupWidth,
      ...(markupNotes.length > 0 ? { markupNotes } : {}),
    };
  }

  /** Build one core-resolved human note action at an authoritative semantic address. */
  private prepareUserNote(
    input: Extract<HunkReviewActionV1, { type: "notes/create-user" }>["note"],
  ): ReviewAction {
    const pair = this.reviewFilePair(input.fileKey);
    if (!pair) throw new Error("The selected review file no longer exists.");
    if (!pair.semantic.hunks[input.hunkIndex])
      throw new Error("The selected review hunk no longer exists.");
    if (!input.body.trim()) throw new Error("A user note body is required.");
    this.reviewMarkupFeedback(input.markup);
    const range = [input.line, input.line] as [number, number];
    const annotation = {
      id: `user:${Date.now()}-${++this.userNoteSequence}`,
      source: "user" as const,
      summary: input.body.trim(),
      ...(input.markup ? { markup: input.markup } : {}),
      author: "user",
      createdAt: new Date().toISOString(),
      editable: true,
      ...(input.side === "old" ? { oldRange: range } : { newRange: range }),
    };
    const note = projectReviewNote({
      annotation,
      fileKey: input.fileKey,
      hunks: pair.file.metadata.hunks,
      origin: "user",
      editable: true,
    });
    return {
      type: "notes/add-user",
      expectedGeneration: this.snapshot.projection.document.generation,
      note: {
        note,
        contextDigest: reviewLineContextDigest(pair.semantic, input.side, input.line),
        contextDigests: this.mutableNoteDigests(pair.semantic, annotation),
        resolution: "active",
      },
    };
  }

  /** Prepare replacement of one editable human note while retaining its core-owned anchor. */
  private prepareUserNoteUpdate(noteId: string, body: string, markup?: string): ReviewAction {
    const state = this.snapshot.store.getSnapshot();
    const existing = state.userNotes.find((entry) => entry.note.id === noteId);
    if (!existing) throw new Error(`No user note matches id ${noteId}.`);
    if (!body.trim()) throw new Error("A user note body is required.");
    this.reviewMarkupFeedback(markup);
    const { markup: existingMarkup, ...withoutMarkup } = existing.note;
    return {
      type: "notes/update-user",
      expectedGeneration: state.documentGeneration,
      noteId,
      note: {
        ...existing,
        note: {
          ...withoutMarkup,
          summary: body.trim(),
          ...(markup === undefined
            ? existingMarkup === undefined
              ? {}
              : { markup: existingMarkup }
            : markup.trim()
              ? { markup }
              : {}),
          updatedAt: new Date().toISOString(),
        },
      },
    };
  }

  /** Toggle and materialize one generation-addressed source capability exactly once. */
  private async toggleSourceGapForState(
    fileKey: string,
    gapId: string,
    expectedGeneration: string,
    expectedRevision: number,
  ) {
    const state = this.snapshot.store.getSnapshot();
    if (state.documentGeneration !== expectedGeneration) throw new Error("stale-generation");
    if (state.stateRevision !== expectedRevision) throw new Error("stale-revision");
    const pair = this.reviewFilePair(fileKey);
    if (!pair?.file.sourceFetcher) throw new Error("Expanded source is unavailable for this file.");
    const address = reviewGapAddress(pair.semantic, gapId);
    const side = pair.file.metadata.type === "deleted" ? "old" : "new";
    const resourceId = pair.semantic.sourceResourceIds[side];
    const descriptor = this.snapshot.projection.document.resources.find(
      (resource) => resource.id === resourceId && resource.kind === "source",
    ) as ReviewSourceResourceDescriptorV1 | undefined;
    if (!address || !descriptor) throw new Error("The collapsed source gap is invalid.");
    const expanding = !state.expandedGaps.some(
      (gap) => gap.fileKey === fileKey && gap.gapId === gapId && gap.expanded,
    );
    this.commitReviewActions([
      {
        type: "expansion/toggle",
        expectedGeneration,
        gap: {
          fileKey,
          gapId,
          side,
          ...address,
          sourceIdentity: descriptor.sourceIdentity,
          expanded: expanding,
        },
      },
    ]);
    if (!expanding) return;
    const status = this.snapshot.store.getSnapshot().sourceStatusByFileKey[fileKey];
    if (status?.kind === "loaded" || status?.kind === "loading") return;
    this.commitReviewActions([
      {
        type: "expansion/set-source-status",
        expectedGeneration,
        fileKey,
        status: { kind: "loading" },
      },
    ]);
    const loadKey = `${expectedGeneration}\0${fileKey}\0${side}`;
    let load = this.sourceLoads.get(loadKey);
    if (!load) {
      const fetcher = pair.file.sourceFetcher;
      load = fetcher
        .getFullText(side)
        .then((text) => {
          if (
            this.disposed ||
            this.snapshot.store.getSnapshot().documentGeneration !== expectedGeneration ||
            this.reviewFilePair(fileKey)?.file.sourceFetcher !== fetcher
          )
            return;
          if (text === null) {
            this.commitReviewActions([
              {
                type: "expansion/set-source-status",
                expectedGeneration,
                fileKey,
                status: { kind: "error" },
              },
            ]);
            return;
          }
          const bytes = Buffer.byteLength(text, "utf8");
          if (bytes > MAX_REVIEW_SOURCE_RESOURCE_BYTES)
            throw new SourceTextTooLargeError(MAX_REVIEW_SOURCE_RESOURCE_BYTES);
          descriptor.byteLength = bytes;
          descriptor.digest = reviewDigest(text);
          this.snapshot.projection.resourceContents[descriptor.id] = text;
          this.commitReviewActions([
            {
              type: "expansion/set-source-status",
              expectedGeneration,
              fileKey,
              status: { kind: "loaded", text },
            },
          ]);
        })
        .catch((error: unknown) => {
          if (
            this.disposed ||
            this.snapshot.store.getSnapshot().documentGeneration !== expectedGeneration
          )
            return;
          if (!(error instanceof SourceTextTooLargeError)) {
            console.error(
              `hunk: failed to load ${side} source for ${pair.file.path} (${pair.file.id}).`,
              error,
            );
          }
          this.commitReviewActions([
            {
              type: "expansion/set-source-status",
              expectedGeneration,
              fileKey,
              status: {
                kind: "error",
                ...(error instanceof SourceTextTooLargeError
                  ? { reason: "too-large" as const }
                  : {}),
              },
            },
          ]);
        })
        .finally(() => this.sourceLoads.delete(loadKey));
      this.sourceLoads.set(loadKey, load);
    }
    await load;
  }

  /** Strictly validate every nested field of one advertised semantic action DTO. */
  private parseReviewAction(action: unknown): HunkReviewActionV1 | "invalid" | "unsupported" {
    if (!action || typeof action !== "object" || Array.isArray(action)) return "invalid";
    const candidate = action as Record<string, unknown>;
    if (typeof candidate.type !== "string") return "invalid";
    switch (candidate.type) {
      case "filter/set":
        return this.hasExactKeys(candidate, ["type", "filter"]) &&
          typeof candidate.filter === "string" &&
          candidate.filter.length <= 16_384
          ? (candidate as unknown as HunkReviewActionV1)
          : "invalid";
      case "notes/set-visibility":
        return this.hasExactKeys(candidate, ["type", "visible"]) &&
          typeof candidate.visible === "boolean"
          ? (candidate as unknown as HunkReviewActionV1)
          : "invalid";
      case "selection/select": {
        if (
          !this.hasExactKeys(candidate, [
            "type",
            "selection",
            ...(candidate.reveal === undefined ? [] : ["reveal"]),
          ])
        )
          return "invalid";
        const selection = candidate.selection;
        if (!selection || typeof selection !== "object" || Array.isArray(selection))
          return "invalid";
        const selected = selection as Record<string, unknown>;
        const selectionKeys = [
          "fileKey",
          "hunkIndex",
          ...(selected.side === undefined ? [] : ["side"]),
          ...(selected.line === undefined ? [] : ["line"]),
          ...(selected.contextDigest === undefined ? [] : ["contextDigest"]),
        ];
        if (
          !this.hasExactKeys(selected, selectionKeys) ||
          !(selected.fileKey === null || typeof selected.fileKey === "string") ||
          !Number.isInteger(selected.hunkIndex) ||
          (selected.hunkIndex as number) < 0 ||
          (selected.side !== undefined && selected.side !== "old" && selected.side !== "new") ||
          (selected.line !== undefined &&
            (!Number.isInteger(selected.line) || (selected.line as number) <= 0)) ||
          (selected.contextDigest !== undefined && typeof selected.contextDigest !== "string")
        )
          return "invalid";
        if (candidate.reveal !== undefined) {
          const reveal = candidate.reveal;
          if (!reveal || typeof reveal !== "object" || Array.isArray(reveal)) return "invalid";
          const revealed = reveal as Record<string, unknown>;
          const revealKeys = [
            "kind",
            ...(revealed.scrollToNote === undefined ? [] : ["scrollToNote"]),
          ];
          if (
            !this.hasExactKeys(revealed, revealKeys) ||
            (revealed.kind !== "hunk" &&
              revealed.kind !== "file-top" &&
              revealed.kind !== "line") ||
            (revealed.scrollToNote !== undefined && typeof revealed.scrollToNote !== "boolean")
          )
            return "invalid";
        }
        return candidate as unknown as HunkReviewActionV1;
      }
      case "selection/set-line": {
        const keys = [
          "type",
          "fileKey",
          "hunkIndex",
          "side",
          "line",
          ...(candidate.contextDigest === undefined ? [] : ["contextDigest"]),
          ...(candidate.reveal === undefined ? [] : ["reveal"]),
        ];
        return this.hasExactKeys(candidate, keys) &&
          typeof candidate.fileKey === "string" &&
          Number.isInteger(candidate.hunkIndex) &&
          (candidate.hunkIndex as number) >= 0 &&
          (candidate.side === "old" || candidate.side === "new") &&
          Number.isInteger(candidate.line) &&
          (candidate.line as number) > 0 &&
          (candidate.contextDigest === undefined || typeof candidate.contextDigest === "string") &&
          (candidate.reveal === undefined || typeof candidate.reveal === "boolean")
          ? (candidate as unknown as HunkReviewActionV1)
          : "invalid";
      }
      case "notes/create-user": {
        const note = candidate.note;
        if (
          !this.hasExactKeys(candidate, ["type", "note"]) ||
          !note ||
          typeof note !== "object" ||
          Array.isArray(note)
        )
          return "invalid";
        const value = note as Record<string, unknown>;
        return this.hasExactKeys(value, [
          "fileKey",
          "hunkIndex",
          "side",
          "line",
          "body",
          ...(value.markup === undefined ? [] : ["markup"]),
        ]) &&
          typeof value.fileKey === "string" &&
          Number.isInteger(value.hunkIndex) &&
          (value.hunkIndex as number) >= 0 &&
          (value.side === "old" || value.side === "new") &&
          Number.isInteger(value.line) &&
          (value.line as number) > 0 &&
          typeof value.body === "string" &&
          Buffer.byteLength(value.body, "utf8") <= 256 * 1024 &&
          (value.markup === undefined ||
            (typeof value.markup === "string" &&
              Buffer.byteLength(value.markup, "utf8") <= 256 * 1024))
          ? (candidate as unknown as HunkReviewActionV1)
          : "invalid";
      }
      case "notes/update-user":
        return this.hasExactKeys(candidate, [
          "type",
          "noteId",
          "body",
          ...(candidate.markup === undefined ? [] : ["markup"]),
        ]) &&
          typeof candidate.noteId === "string" &&
          typeof candidate.body === "string" &&
          Buffer.byteLength(candidate.body, "utf8") <= 256 * 1024 &&
          (candidate.markup === undefined ||
            (typeof candidate.markup === "string" &&
              Buffer.byteLength(candidate.markup, "utf8") <= 256 * 1024))
          ? (candidate as unknown as HunkReviewActionV1)
          : "invalid";
      case "notes/remove-user":
      case "notes/remove-live":
        return this.hasExactKeys(candidate, ["type", "noteId"]) &&
          typeof candidate.noteId === "string"
          ? (candidate as unknown as HunkReviewActionV1)
          : "invalid";
      case "expansion/toggle":
        return this.hasExactKeys(candidate, ["type", "fileKey", "gapId"]) &&
          typeof candidate.fileKey === "string" &&
          typeof candidate.gapId === "string"
          ? (candidate as unknown as HunkReviewActionV1)
          : "invalid";
      case "session/reload":
        return this.hasExactKeys(candidate, ["type"])
          ? (candidate as unknown as HunkReviewActionV1)
          : "invalid";
      case "trust/decide":
        return this.hasExactKeys(candidate, ["type", "decision"]) &&
          (candidate.decision === "trusted" || candidate.decision === "denied")
          ? (candidate as unknown as HunkReviewActionV1)
          : "invalid";
      default:
        return "unsupported";
    }
  }

  /** Apply only a strictly validated generation- and revision-guarded semantic action. */
  private async applyReviewAction(input: ApplyReviewActionInput): Promise<HunkReviewCommandResult> {
    if (typeof input.generation !== "string" || input.generation.length === 0) {
      return this.reviewCommandError("invalid-generation", "Action generation is required.");
    }
    const targetError = this.validateReviewCommandTarget(input.sessionId, input.generation);
    if (targetError) return targetError;
    const action = this.parseReviewAction(input.action);
    if (action === "unsupported") {
      return this.reviewCommandError("unsupported-action", "Review action is not supported.");
    }
    if (action === "invalid") {
      return this.reviewCommandError("invalid-action", "Review action payload is invalid.");
    }
    const selectionAction =
      action.type === "selection/select" || action.type === "selection/set-line";
    const before = this.snapshot.store.getSnapshot();
    if (!selectionAction && this.asynchronousActionReservation) {
      return this.reviewCommandError(
        "stale-revision",
        "Another asynchronous review action already claimed this state revision.",
      );
    }
    if (
      !selectionAction &&
      (input.expectedStateRevision === undefined ||
        input.expectedStateRevision !== before.stateRevision)
    ) {
      return this.reviewCommandError(
        "stale-revision",
        `Review state revision ${String(input.expectedStateRevision)} is stale; current revision is ${before.stateRevision}.`,
      );
    }
    const asynchronous = action.type === "session/reload" || action.type === "trust/decide";
    const reservationToken = Symbol("review-action");
    if (asynchronous) {
      this.asynchronousActionReservation = {
        generation: before.documentGeneration,
        stateRevision: before.stateRevision,
        token: reservationToken,
      };
    }
    try {
      switch (action.type) {
        case "notes/create-user":
          this.commitReviewActions([this.prepareUserNote(action.note)], true);
          break;
        case "notes/update-user":
          this.commitReviewActions(
            [this.prepareUserNoteUpdate(action.noteId, action.body, action.markup)],
            true,
          );
          break;
        case "notes/remove-user": {
          if (!before.userNotes.some((entry) => entry.note.id === action.noteId)) {
            throw new Error(`No user note matches id ${action.noteId}.`);
          }
          this.commitReviewActions(
            [
              {
                type: "notes/remove-user",
                expectedGeneration: before.documentGeneration,
                noteId: action.noteId,
              },
            ],
            true,
          );
          break;
        }
        case "notes/remove-live": {
          const note = before.liveNotes.find((entry) => entry.note.id === action.noteId);
          if (!note || (note.note.origin !== "live-agent" && note.note.editable === false)) {
            throw new Error(`Live note ${action.noteId} cannot be removed.`);
          }
          this.commitReviewActions(
            [
              {
                type: "notes/remove-live",
                expectedGeneration: before.documentGeneration,
                noteId: action.noteId,
              },
            ],
            true,
          );
          this.releaseSessionCommentIdentity(action.noteId);
          break;
        }
        case "expansion/toggle":
          await this.toggleSourceGapForState(
            action.fileKey,
            action.gapId,
            input.generation,
            before.stateRevision,
          );
          break;
        case "session/reload":
          if (!canReloadInput(this.snapshot.bootstrap.input))
            throw new Error("This review cannot be reloaded.");
          await this.reload("manual", this.rawInput, {
            resetApp: false,
            reloadExtensions: true,
            sourcePath: this.currentSourcePath(),
          });
          break;
        case "trust/decide":
          if (!this.snapshot.trust.promptRepoRoot)
            throw new Error("No repository extension trust decision is pending.");
          await this.decideExtensionTrust(action.decision);
          break;
        default:
          this.commitReviewActions([action], true);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "stale-generation") {
        return this.reviewCommandError("stale-generation", "The review generation changed.");
      }
      if (error instanceof Error && error.message === "stale-revision") {
        return this.reviewCommandError("stale-revision", "The review state changed.");
      }
      return this.reviewCommandError(
        "invalid-action",
        error instanceof Error ? error.message : "Review action failed.",
      );
    } finally {
      if (this.asynchronousActionReservation?.token === reservationToken) {
        this.asynchronousActionReservation = undefined;
      }
    }
    const next = this.snapshot.store.getSnapshot();
    const result = {
      kind: "review-action" as const,
      generation: next.documentGeneration,
      stateRevision: next.stateRevision,
      state: createHunkReviewState(next),
    };
    assertReviewProducerEnvelopeWithinBounds(
      {
        type: "command-result",
        requestId: "00000000-0000-0000-0000-000000000000",
        ok: true,
        result,
      },
      "Review action result",
    );
    return result;
  }

  /** Return a reconnect snapshot for the active atomic document/state publication. */
  private getReviewSnapshot(input: GetReviewSnapshotInput): HunkReviewCommandResult {
    const targetError = this.validateReviewCommandTarget(input.sessionId, input.generation);
    if (targetError) return targetError;
    const { bootstrap, projection, store } = this.snapshot;
    const state = store.getSnapshot();
    const result = {
      kind: "review-snapshot" as const,
      generation: state.documentGeneration,
      manifest: createHunkReviewManifest(bootstrap, projection.document),
      state: createHunkReviewState(state),
    };
    assertReviewProducerEnvelopeWithinBounds(
      {
        type: "command-result",
        requestId: "00000000-0000-0000-0000-000000000000",
        ok: true,
        result,
      },
      "Review reconnect snapshot",
    );
    return result;
  }

  /** Return one cached applied result before retry inputs are resolved or revalidated. */
  private getSessionCommentResult(command: "comment" | "comment_batch", requestId: string) {
    const key = `${command}\0${requestId}`;
    const cached = this.sessionCommentResults.get(key);
    if (!cached) return undefined;
    this.sessionCommentResults.delete(key);
    this.sessionCommentResults.set(key, cached);
    return cached.result;
  }

  /** Retain bounded retry metadata and release generated-id bookkeeping on LRU eviction. */
  private cacheSessionCommentResult(
    command: "comment" | "comment_batch",
    requestId: string,
    result: AppliedSessionCommentResult,
  ) {
    const key = `${command}\0${requestId}`;
    this.sessionCommentResults.delete(key);
    this.sessionCommentResults.set(
      key,
      command === "comment"
        ? { command, requestId, result: result as AppliedCommentResult }
        : { command, requestId, result: result as AppliedCommentBatchResult },
    );
    while (this.sessionCommentResults.size > MAX_SESSION_COMMENT_RESULTS) {
      const oldestKey = this.sessionCommentResults.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.sessionCommentResults.get(oldestKey)!;
      this.sessionCommentResults.delete(oldestKey);
      if (oldest.command === "comment") {
        this.sessionCommentIds.delete(oldest.requestId);
      } else {
        oldest.result.applied.forEach((_, index) =>
          this.sessionCommentIds.delete(`${oldest.requestId}:${index}`),
        );
      }
    }
  }

  /** Allocate one collision-free generated id and retain it for request-identity retries. */
  private allocateSessionCommentId(requestIdentity: string) {
    const retained = this.sessionCommentIds.get(requestIdentity);
    if (retained) return { commentId: retained, allocated: false };
    const state = this.snapshot.store.getSnapshot();
    const occupied = new Set([
      ...state.document.files.flatMap((file) => file.notes.map((note) => note.id)),
      ...state.liveNotes.map((entry) => entry.note.id),
      ...state.userNotes.map((entry) => entry.note.id),
      ...this.sessionCommentIds.values(),
    ]);
    const base = `mcp:${requestIdentity}`;
    let commentId = base;
    for (let suffix = 1; occupied.has(commentId); suffix += 1) commentId = `${base}:${suffix}`;
    this.sessionCommentIds.set(requestIdentity, commentId);
    return { commentId, allocated: true };
  }

  /** Forget retry identities whose generated mutable note was explicitly removed. */
  private releaseSessionCommentIdentity(commentId: string) {
    for (const [identity, allocated] of this.sessionCommentIds) {
      if (allocated === commentId) this.sessionCommentIds.delete(identity);
    }
  }

  /** Resolve and validate one agent comment without mutating authoritative state. */
  private prepareSessionComment(
    input: Extract<HunkSessionServerMessage, { command: "comment" }>["input"],
    commentId: string,
    createdAt: string,
  ) {
    const file = findDiffFileByPath(this.snapshot.bootstrap.changeset.files, input.filePath);
    if (!file) throw new Error(`No diff file matches ${input.filePath}.`);
    const target = resolveCommentTarget(file, input);
    const feedback = this.reviewMarkupFeedback(input.markup);
    const semantic = this.snapshot.projection.document.files.find(
      (candidate) => candidate.runtimeId === file.id,
    )!;
    const annotation = buildLiveComment(
      { ...input, side: target.side, line: target.line },
      commentId,
      createdAt,
      target.hunkIndex,
    );
    const note: ReviewStoredNote = {
      note: projectReviewNote({
        annotation,
        fileKey: semantic.key,
        hunks: file.metadata.hunks,
        origin: "live-agent",
      }),
      contextDigest: reviewLineContextDigest(semantic, target.side, target.line),
      contextDigests: this.mutableNoteDigests(semantic, annotation),
      resolution: "active",
    };
    return {
      semantic,
      note,
      result: {
        commentId,
        fileId: file.id,
        filePath: file.path,
        hunkIndex: target.hunkIndex,
        side: target.side,
        line: target.line,
        ...feedback,
      } satisfies AppliedCommentResult,
    };
  }

  /** Add one agent comment through one preflighted state publication. */
  private addSessionComment(
    input: Extract<HunkSessionServerMessage, { command: "comment" }>["input"],
    requestIdentity: string,
  ): AppliedCommentResult {
    const allocated = this.allocateSessionCommentId(requestIdentity);
    let prepared: ReturnType<ReviewSessionRuntime["prepareSessionComment"]>;
    try {
      prepared = this.prepareSessionComment(input, allocated.commentId, new Date().toISOString());
    } catch (error) {
      if (allocated.allocated) this.sessionCommentIds.delete(requestIdentity);
      throw error;
    }
    const existing = this.snapshot.store
      .getSnapshot()
      .liveNotes.find((entry) => entry.note.id === allocated.commentId);
    if (existing) return prepared.result;
    const before = this.snapshot.store.getSnapshot();
    const actions: ReviewAction[] = [
      {
        type: "notes/add-live",
        expectedGeneration: before.documentGeneration,
        notes: [prepared.note],
      },
    ];
    if (input.reveal) {
      actions.push(
        { type: "notes/set-visibility", visible: true },
        {
          type: "selection/select",
          selection: { fileKey: prepared.semantic.key, hunkIndex: prepared.result.hunkIndex },
          reveal: { kind: "hunk", scrollToNote: true },
        },
      );
    }
    this.assertCommandResultWithinBounds(prepared.result, "Comment result");
    this.commitReviewActions(actions);
    return prepared.result;
  }

  /** Resolve one legacy agent navigation request against the same semantic store. */
  private navigateSession(
    input: Extract<HunkSessionServerMessage, { command: "navigate_to_hunk" }>["input"],
  ): NavigatedSelectionResult {
    const state = this.snapshot.store.getSnapshot();
    const visible = state.document.files.filter((file) =>
      reviewFileMatchesFilter(file, state.filter),
    );
    let semantic: ReviewFileV1 | undefined;
    let hunkIndex = input.hunkIndex;
    if (input.commentDirection) {
      const annotatedKeys = new Set(
        [
          ...state.document.files.flatMap((file) => file.notes),
          ...state.liveNotes.map((entry) => entry.note),
          ...state.userNotes.map((entry) => entry.note),
        ].flatMap((note) =>
          note.anchor.ownerHunkIndex === undefined
            ? []
            : [`${note.fileKey}\0${note.anchor.ownerHunkIndex}`],
        ),
      );
      const annotated = visible.flatMap((file) =>
        file.hunks.flatMap((_, index) =>
          annotatedKeys.has(`${file.key}\0${index}`)
            ? [{ fileKey: file.key, hunkIndex: index }]
            : [],
        ),
      );
      if (annotated.length === 0)
        throw new Error("No annotated hunks found in the current review.");
      const visibleFileIndex = visible.findIndex((file) => file.key === state.selection.fileKey);
      const compareToSelection = (target: (typeof annotated)[number]) => {
        const fileIndex = visible.findIndex((file) => file.key === target.fileKey);
        return fileIndex === visibleFileIndex
          ? target.hunkIndex - state.selection.hunkIndex
          : fileIndex - visibleFileIndex;
      };
      const target =
        input.commentDirection === "next"
          ? (annotated.find((candidate) => compareToSelection(candidate) > 0) ?? annotated[0]!)
          : ([...annotated].reverse().find((candidate) => compareToSelection(candidate) < 0) ??
            annotated.at(-1)!);
      semantic = state.document.files.find((file) => file.key === target.fileKey);
      hunkIndex = target.hunkIndex;
    } else {
      if (!input.filePath) throw new Error("navigate requires a file target.");
      semantic = state.document.files.find(
        (file) => file.path === input.filePath || file.previousPath === input.filePath,
      );
      if (!semantic) throw new Error(`No diff file matches ${input.filePath}.`);
      if (hunkIndex === undefined) {
        if (!input.side || input.line === undefined)
          throw new Error("navigate requires a hunk or line target.");
        const targetSide = input.side;
        const targetLine = input.line;
        hunkIndex = semantic.hunks.findIndex((hunk) => {
          const range =
            targetSide === "new"
              ? [hunk.additionStart, hunk.additionStart + Math.max(1, hunk.additionCount) - 1]
              : [hunk.deletionStart, hunk.deletionStart + Math.max(1, hunk.deletionCount) - 1];
          return targetLine >= range[0]! && targetLine <= range[1]!;
        });
      }
    }
    if (!semantic || hunkIndex === undefined || hunkIndex < 0 || !semantic.hunks[hunkIndex]) {
      throw new Error("No diff hunk matches the requested target.");
    }
    this.commitReviewActions([
      {
        type: "selection/select",
        selection: { fileKey: semantic.key, hunkIndex },
        reveal: {
          kind: input.line === undefined ? "hunk" : "line",
          scrollToNote: Boolean(input.commentDirection),
        },
      },
    ]);
    const file = this.snapshot.bootstrap.changeset.files.find(
      (candidate) => candidate.id === semantic!.runtimeId,
    )!;
    const hunk = semantic.hunks[hunkIndex]!;
    return {
      fileId: file.id,
      filePath: file.path,
      hunkIndex,
      selectedHunk: {
        index: hunkIndex,
        oldRange: [hunk.deletionStart, hunk.deletionStart + Math.max(1, hunk.deletionCount) - 1],
        newRange: [hunk.additionStart, hunk.additionStart + Math.max(1, hunk.additionCount) - 1],
      },
    };
  }

  /** Handle runtime-native protocol commands and legacy public session names through one store. */
  private async dispatchSessionCommand(
    message: HunkSessionServerMessage,
  ): Promise<HunkSessionCommandResult> {
    const messageRecord = message as unknown as Record<string, unknown>;
    const exactCommandEnvelope =
      Object.keys(messageRecord).length === 4 &&
      Object.keys(messageRecord).every((key) =>
        ["type", "requestId", "command", "input"].includes(key),
      ) &&
      messageRecord.type === "command" &&
      typeof messageRecord.requestId === "string" &&
      messageRecord.requestId.length > 0;
    switch (message.command) {
      case "read_review_resource": {
        const input = exactCommandEnvelope ? parseReadReviewResourceInput(message.input) : null;
        return input
          ? this.readReviewResource(input)
          : this.reviewCommandError("invalid-command", "Resource read payload is invalid.");
      }
      case "apply_review_action": {
        const input = exactCommandEnvelope ? parseApplyReviewActionInput(message.input) : null;
        return input
          ? this.applyReviewAction(input)
          : this.reviewCommandError("invalid-command", "Review action envelope is invalid.");
      }
      case "get_review_snapshot": {
        const input = exactCommandEnvelope ? parseGetReviewSnapshotInput(message.input) : null;
        return input
          ? this.getReviewSnapshot(input)
          : this.reviewCommandError("invalid-command", "Review snapshot payload is invalid.");
      }
      case "get_browser_review_url": {
        const input = message.input;
        const sessionId = this.hostClient?.getRegistration().sessionId;
        if (
          !exactCommandEnvelope ||
          !sessionId ||
          input.sessionId !== sessionId ||
          Object.keys(input).some(
            (key) => !["sessionId", "sessionPath", "repoRoot", "browserOrigin"].includes(key),
          )
        ) {
          throw new Error("Browser review URL request is invalid for this session.");
        }
        const result = { url: this.getBrowserReviewUrl(input.browserOrigin) };
        this.assertCommandResultWithinBounds(result, "Browser review URL result");
        return result;
      }
      case "comment": {
        const cached = this.getSessionCommentResult("comment", message.requestId);
        if (cached) return cached as AppliedCommentResult;
        const result = this.addSessionComment(message.input, message.requestId);
        this.cacheSessionCommentResult("comment", message.requestId, result);
        return result;
      }
      case "comment_batch": {
        const cached = this.getSessionCommentResult("comment_batch", message.requestId);
        if (cached) return cached as AppliedCommentBatchResult;
        const createdAt = new Date().toISOString();
        const allocated: Array<{
          requestIdentity: string;
          commentId: string;
          allocated: boolean;
        }> = [];
        let prepared: Array<ReturnType<ReviewSessionRuntime["prepareSessionComment"]>>;
        try {
          // Resolve every target and validate every markup body before preparing one publication.
          prepared = message.input.comments.map((comment, index) => {
            const requestIdentity = `${message.requestId}:${index}`;
            const id = this.allocateSessionCommentId(requestIdentity);
            allocated.push({ requestIdentity, ...id });
            return this.prepareSessionComment(
              { ...comment, sessionId: message.input.sessionId, reveal: false },
              id.commentId,
              createdAt,
            );
          });
        } catch (error) {
          for (const id of allocated) {
            if (id.allocated) this.sessionCommentIds.delete(id.requestIdentity);
          }
          throw error;
        }
        const before = this.snapshot.store.getSnapshot();
        const existingIds = new Set(before.liveNotes.map((entry) => entry.note.id));
        const additions = prepared.filter((entry) => !existingIds.has(entry.note.note.id));
        const actions: ReviewAction[] = [];
        if (additions.length > 0) {
          actions.push({
            type: "notes/add-live",
            expectedGeneration: before.documentGeneration,
            notes: additions.map((entry) => entry.note),
          });
        }
        const first = prepared[0];
        if (message.input.revealMode === "first" && first) {
          actions.push(
            { type: "notes/set-visibility", visible: true },
            {
              type: "selection/select",
              selection: { fileKey: first.semantic.key, hunkIndex: first.result.hunkIndex },
              reveal: { kind: "hunk", scrollToNote: true },
            },
          );
        }
        this.assertCommandResultWithinBounds(
          { applied: prepared.map((entry) => entry.result) },
          "Comment batch result",
        );
        this.commitReviewActions(actions);
        const result = {
          applied: prepared.map((entry) => entry.result),
        } satisfies AppliedCommentBatchResult;
        this.cacheSessionCommentResult("comment_batch", message.requestId, result);
        return result;
      }
      case "navigate_to_hunk":
        return this.navigateSession(message.input);
      case "reload_session":
        return this.reload("daemon", message.input.nextInput, {
          resetApp: false,
          sourcePath: message.input.sourcePath,
        });
      case "remove_comment": {
        const state = this.snapshot.store.getSnapshot();
        const live = state.liveNotes.some((entry) => entry.note.id === message.input.commentId);
        const user = state.userNotes.some((entry) => entry.note.id === message.input.commentId);
        if (!live && !user)
          throw new Error(`No mutable note matches id ${message.input.commentId}.`);
        this.commitReviewActions([
          {
            type: live ? "notes/remove-live" : "notes/remove-user",
            expectedGeneration: state.documentGeneration,
            noteId: message.input.commentId,
          },
        ]);
        if (live) this.releaseSessionCommentIdentity(message.input.commentId);
        const next = this.snapshot.store.getSnapshot();
        return {
          commentId: message.input.commentId,
          removed: true,
          remainingCommentCount: next.liveNotes.length + next.userNotes.length,
          source: live ? "agent" : "user",
        } satisfies RemovedCommentResult;
      }
      case "clear_comments": {
        const state = this.snapshot.store.getSnapshot();
        const file = message.input.filePath
          ? state.document.files.find(
              (candidate) =>
                candidate.path === message.input.filePath ||
                candidate.previousPath === message.input.filePath,
            )
          : undefined;
        const matchesScope = (entry: ReviewStoredNote) => {
          if (!message.input.filePath) return true;
          if (file && entry.note.fileKey === file.key) return true;
          const currentFile = state.document.files.find(
            (candidate) => candidate.key === entry.note.fileKey,
          );
          return Boolean(
            (currentFile &&
              (currentFile.path === message.input.filePath ||
                currentFile.previousPath === message.input.filePath)) ||
            entry.originalAddress?.path === message.input.filePath ||
            entry.originalAddress?.previousPath === message.input.filePath,
          );
        };
        const live = state.liveNotes.filter(matchesScope);
        const user = state.userNotes.filter(matchesScope);
        if (message.input.filePath && !file && live.length === 0 && user.length === 0) {
          throw new Error(`No diff file matches ${message.input.filePath}.`);
        }
        this.commitReviewActions([
          {
            type: "notes/clear-live",
            expectedGeneration: state.documentGeneration,
            ...(message.input.filePath ? { noteIds: live.map((entry) => entry.note.id) } : {}),
            ...(message.input.filePath && message.input.includeUser
              ? { userNoteIds: user.map((entry) => entry.note.id) }
              : {}),
            includeUser: message.input.includeUser,
          },
        ]);
        for (const entry of live) this.releaseSessionCommentIdentity(entry.note.id);
        const next = this.snapshot.store.getSnapshot();
        return {
          removedCount: live.length + (message.input.includeUser ? user.length : 0),
          remainingCommentCount: next.liveNotes.length + next.userNotes.length,
          filePath: message.input.filePath,
          includeUser: message.input.includeUser,
          removedLiveCommentCount: live.length,
          removedUserNoteCount: message.input.includeUser ? user.length : 0,
          remainingLiveCommentCount: next.liveNotes.length,
          remainingUserNoteCount: next.userNotes.length,
        } satisfies ClearedCommentsResult;
      }
    }
  }

  /** Resolve one caller at most once, including after disposal races. */
  private resolveReload(request: QueuedReload, result: ReloadedSessionResult) {
    if (request.settled) return;
    request.settled = true;
    request.resolve(result);
  }

  /** Reject one caller at most once, including after disposal races. */
  private rejectReload(request: QueuedReload, error: unknown) {
    if (request.settled) return;
    request.settled = true;
    request.reject(error);
  }

  /** Publish a transient headless notice through the same observable runtime state. */
  private showNotice(notice: string) {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.publishMetadata({ notice });
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      if (!this.disposed && this.snapshot.notice === notice) this.publishMetadata({ notice: null });
    }, 2_500);
  }

  /** Replace runtime metadata without disturbing the active generation. */
  private publishMetadata(fields: Partial<Pick<ReviewSessionRuntimeSnapshot, "trust" | "notice">>) {
    this.snapshot = {
      ...this.snapshot,
      ...fields,
      revision: this.snapshot.revision + 1,
    };
    this.notify();
  }

  /** Notify a stable copy so listeners may unsubscribe during publication. */
  private notify() {
    for (const listener of Array.from(this.listeners)) {
      if (this.disposed) break;
      listener();
    }
  }
}

/** Construct one renderer-neutral review authority from an already prepared bootstrap. */
export function createReviewSessionRuntime(
  bootstrap: AppBootstrap,
  options: ReviewSessionRuntimeOptions = {},
) {
  return new ReviewSessionRuntime(bootstrap, options);
}

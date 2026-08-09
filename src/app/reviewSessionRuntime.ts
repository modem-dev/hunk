import { canReloadInput } from "../core/inputReload";
import { resolveConfiguredCliInput } from "../core/config";
import { resolveExperimentalDiffFiles } from "../core/experimental";
import { projectReviewDocument } from "../core/review/document";
import { reconcileReviewState } from "../core/review/reconcile";
import { reviewInputSourceIdentity } from "../core/review/sourceIdentity";
import {
  createReviewStore,
  createReviewStoreFromState,
  type ReviewStore,
} from "../core/review/store";
import type { ReviewDocumentProjectionV1 } from "../core/review/types";
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
  ReloadedSessionResult,
  ReloadSessionOptions,
} from "../session/types";
import { loadConfiguredSessionBootstrap, type SessionBootstrapResult } from "./sessionBootstrap";
import { createWatchedInputController, type WatchedInputRuntime } from "./watchRuntime";
import type { WatchController } from "../core/watchController";
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

/** Renderer-neutral command authority registered by the mounted terminal adapter. */
export interface ReviewSessionCommandAdapter {
  dispatchCommand(message: HunkSessionServerMessage): Promise<HunkSessionCommandResult>;
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
  private commandAdapter: {
    token: number;
    store: ReviewStore;
    adapter: ReviewSessionCommandAdapter;
  } | null = null;
  private commandAdapterSequence = 0;
  private reloadQueue: QueuedReload[] = [];
  private supersededReloads: QueuedReload[] = [];
  private activeReload: QueuedReload | null = null;
  private processingReloads = false;
  private latestRequestedEpoch = 0;
  private generationSequence = 0;
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
    const store = createReviewStore(projection.document, {
      showAgentNotes: bootstrap.initialShowAgentNotes ?? false,
    });
    const pendingRepoRoot = bootstrap.extensions?.pendingTrustRepoRoot ?? null;
    const promptRepoRoot = bootstrap.input.options.pager ? null : pendingRepoRoot;
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

  /** Build the internal local review URL while keeping the clear capability process-local. */
  getBrowserReviewUrl(origin: string) {
    const sessionId = this.hostClient?.getRegistration().sessionId;
    if (!sessionId) throw new Error("Review session is not attached to the local broker.");
    return buildBrowserReviewUrl(origin, sessionId, this.browserReviewCapability.capability);
  }

  /** Open the internal browser review without exposing a public CLI surface. */
  openBrowserReview(origin: string) {
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

  /** Attach a renderer adapter only while it targets the current semantic store generation. */
  registerSessionCommandAdapter(store: ReviewStore, adapter: ReviewSessionCommandAdapter) {
    if (this.disposed || store !== this.snapshot.store) return () => undefined;
    const token = ++this.commandAdapterSequence;
    this.commandAdapter = { token, store, adapter };
    return () => {
      if (this.commandAdapter?.token !== token) return;
      this.commandAdapter = null;
    };
  }

  /** Queue every reload trigger through one ordered executor. */
  reload(
    reason: SessionReloadReason,
    input: CliInput = this.snapshot.bootstrap.input,
    options: ReloadSessionOptions = {},
  ): Promise<ReloadedSessionResult> {
    if (this.disposed) return Promise.reject(new Error("Review session runtime is disposed."));
    const epoch = ++this.latestRequestedEpoch;
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

  /** Dismiss the current trust question without persisting a decision. */
  dismissTrustPrompt() {
    if (!this.snapshot.trust.promptRepoRoot) return;
    this.publishMetadata({
      trust: { ...this.snapshot.trust, promptRepoRoot: null },
    });
  }

  /** Persist a repo-extension trust answer and load newly trusted code only through reload. */
  async decideExtensionTrust(decision: ExtensionTrustDecision) {
    const repoRoot = this.snapshot.trust.promptRepoRoot;
    if (!repoRoot) return;
    this.publishMetadata({ trust: { ...this.snapshot.trust, promptRepoRoot: null } });
    try {
      this.deps.writeExtensionTrustImpl(repoRoot, decision);
    } catch (error) {
      this.showNotice(
        error instanceof Error ? error.message : "Failed to record the trust decision.",
      );
      return;
    }

    if (decision === "denied") {
      this.showNotice("Won't run this repository's extensions");
      return;
    }
    if (!canReloadInput(this.snapshot.bootstrap.input)) {
      this.showNotice("Trusted this repository • restart Hunk to load its extensions");
      return;
    }
    try {
      await this.reload("manual", this.rawInput, {
        resetApp: false,
        reloadExtensions: true,
        sourcePath: this.currentSourcePath(),
      });
    } catch {
      this.showNotice("Failed to reload after trusting this repository's extensions.");
    }
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
        try {
          const prepared = await this.prepareReload(request);
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

  /** Atomically replace bootstrap, projection, resources, store, extensions, and trust state. */
  private publishReload(reload: PreparedReload): ReloadedSessionResult {
    const { bootstrap, applied } = reload.prepared;
    this.generationSequence += 1;
    const projection = projectBootstrap(bootstrap, `generation:runtime:${this.generationSequence}`);
    const previousState = this.snapshot.store.getSnapshot();
    const store =
      reload.options.resetApp === false
        ? createReviewStoreFromState({
            ...reconcileReviewState(previousState, projection.document),
            stateRevision: previousState.stateRevision + 1,
          })
        : createReviewStore(projection.document, {
            showAgentNotes: bootstrap.initialShowAgentNotes ?? false,
          });
    const previousExtensions = this.snapshot.extensions;
    if (reload.reloadedExtensions) {
      if (previousExtensions !== reload.extensions) this.closeExtensionResult(previousExtensions);
      this.extensionsCwd = reload.cwd;
    }
    bootstrap.extensions = reload.extensions;
    if (reload.extensions) {
      reportExtensionApplyIssues(applied.issues, reload.extensions.context);
    }
    if (this.disposed) {
      if (reload.reloadedExtensions) this.closeExtensionResult(reload.extensions);
      throw new Error("Review session runtime is disposed.");
    }
    const pendingRepoRoot = reload.extensions?.pendingTrustRepoRoot ?? null;
    let promptRepoRoot: string | null = null;
    if (
      !bootstrap.input.options.pager &&
      pendingRepoRoot &&
      !this.offeredTrustRepoRoots.has(pendingRepoRoot)
    ) {
      this.offeredTrustRepoRoots.add(pendingRepoRoot);
      promptRepoRoot = pendingRepoRoot;
    }
    const nextSnapshot: ReviewSessionRuntimeSnapshot = {
      revision: this.snapshot.revision + 1,
      bootstrap,
      projection,
      store,
      extensions: reload.extensions,
      trust: { pendingRepoRoot, promptRepoRoot },
      notice: this.snapshot.notice,
      remountVersion: this.snapshot.remountVersion + (reload.options.resetApp === false ? 0 : 1),
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
    if (this.disposed) {
      if (reload.reloadedExtensions) this.closeExtensionResult(reload.extensions);
      throw new Error("Review session runtime is disposed.");
    }
    // Cutover order is deliberate: no old callback or adapter remains live while the broker
    // registration and runtime generation are being replaced.
    this.retireStoreAndCommandAuthority();
    if (this.disposed) throw new Error("Review session runtime is disposed.");
    this.snapshot = nextSnapshot;
    if (this.hostClient && nextRegistration) {
      this.hostClient.replaceSession(nextRegistration, nextSessionSnapshot);
      this.hostClient.setBridge({
        dispatchCommand: (message) => this.dispatchSessionCommand(message),
      });
    }
    const result = {
      sessionId,
      inputKind: bootstrap.input.kind,
      title: bootstrap.changeset.title,
      sourceLabel: bootstrap.changeset.sourceLabel,
      fileCount: bootstrap.changeset.files.length,
      selectedFilePath: nextSessionSnapshot.state.selectedFilePath,
      selectedHunkIndex: nextSessionSnapshot.state.selectedHunkIndex,
    };
    if (this.disposed) return result;

    this.bindStore(store);
    if (this.disposed) return result;
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
    this.commandAdapter = null;
    this.commandAdapterSequence += 1;
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
      default:
        return "unsupported";
    }
  }

  /** Apply only a strictly validated generation-guarded semantic action. */
  private applyReviewAction(input: ApplyReviewActionInput): HunkReviewCommandResult {
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
    const next = this.snapshot.store.dispatch(action);
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

  /** Handle runtime-native protocol commands before delegating legacy terminal commands. */
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
      default: {
        const adapter = this.commandAdapter;
        if (!adapter || adapter.store !== this.snapshot.store) {
          throw new Error("The terminal command adapter is not ready.");
        }
        return adapter.adapter.dispatchCommand(message);
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

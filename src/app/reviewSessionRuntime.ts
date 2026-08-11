import { canReloadInput } from "../core/inputReload";
import { SourceTextTooLargeError } from "../core/fileSource";
import { buildLiveComment, findDiffFileByPath, resolveCommentTarget } from "../core/liveComments";
import { resolveConfiguredCliInput } from "../core/config";
import { resolveExperimentalDiffFiles } from "../core/experimental";
import { projectReviewDocument } from "../core/review/document";
import { reviewDigest } from "../core/review/identity";
import {
  planReviewIntent,
  ReviewIntentPlanningError,
  type ReviewIntent,
  type ReviewIntentEffect,
  type ReviewIntentFacts,
  type ReviewSourceLoadEffect,
} from "../core/review/intents";
import { encodeJsonStream, JsonStreamSizeError } from "../core/review/jsonStream";
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
import type { AppBootstrap, CliInput, DiffFile } from "../core/types";
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
  MAX_REVIEW_RESOURCE_BYTES,
  MAX_REVIEW_SOURCE_RESOURCE_BYTES,
  REVIEW_RESOURCE_CHUNK_BYTES,
  ReviewProducerCapacityError,
  assertReviewProducerEnvelopeWithinBounds,
  parseApplyReviewActionInput,
  parseGetReviewSnapshotInput,
  parseHunkReviewActionV1,
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
  HunkSessionRegistration,
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
  /** Supply runtime-owned identity and timestamp facts deterministically in tests. */
  nowImpl?: () => Date;
}

export type ReviewIntentPreconditions =
  | { mode: "current" }
  | { mode: "generation"; expectedGeneration: string }
  | {
      mode: "revision";
      expectedGeneration: string;
      expectedStateRevision: number;
    };

export interface ReviewIntentExecution {
  before: ReviewState;
  state: ReviewState;
  changed: boolean;
  createdNote?: ReviewStoredNote;
  /** Runtime effects begin after commit; browser compatibility callers may await completion. */
  effectCompletion?: Promise<void>;
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
  /** Raw authoritative invocation used to prepare this candidate. */
  requestedInput: CliInput;
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
const MAX_ENCODED_RESOURCE_CACHE_BYTES = MAX_REVIEW_RESOURCE_BYTES * 2;

/** Reject an unclassified discriminated-union member at compile time and runtime. */
function assertNever(value: never, context: string): never {
  const type = (value as { type?: unknown }).type;
  throw new Error(`Unclassified ${context}${typeof type === "string" ? `: ${type}` : "."}`);
}

interface CachedEncodedResource {
  bytes: Buffer;
  byteLength: number;
  digest: string;
}

interface EncodedResourceCache {
  entries: Map<string, CachedEncodedResource>;
  totalBytes: number;
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
  private currentRawInput: CliInput;
  private readonly launchExperimental: boolean;
  private readonly launchExtensionsEnabled: boolean | undefined;
  private readonly launchExtensionPaths: string[] | undefined;
  private readonly offeredTrustRepoRoots = new Set<string>();
  private readonly startedExtensionIds = new Set<string>();
  private readonly closedExtensionResults = new WeakSet<ExtensionLoadResult>();
  private readonly preparingExtensionResults = new Map<number, ExtensionLoadResult>();
  private extensionsCwd: string;
  private rendererFields: SessionRendererSnapshotFields = {};
  private lastBrokerPublicationKey: string | undefined;
  private readonly preparedBrokerSnapshots = new WeakMap<
    ReviewState,
    {
      publicationKey: string;
      snapshot: ReturnType<typeof createSessionSnapshotFromReviewState>;
    }
  >();
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
  private readonly sourceFetcherIdentities = new WeakMap<object, string>();
  private sourceFetcherIdentitySequence = 0;
  /** Generation projections own bounded encoded bytes without widening the protocol model. */
  private readonly encodedResourceBytes = new WeakMap<
    ReviewDocumentProjectionV1,
    EncodedResourceCache
  >();
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
      nowImpl: options.deps?.nowImpl ?? (() => new Date()),
    };
    const launchInput = options.rawInput ?? bootstrap.input;
    this.currentRawInput = launchInput;
    this.launchExperimental = launchInput.options.experimental === true;
    this.launchExtensionsEnabled = launchInput.options.extensions;
    this.launchExtensionPaths = launchInput.options.extensionPaths;
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
    this.lastBrokerPublicationKey = this.brokerPublicationKey(this.snapshot.store.getSnapshot());
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

  /** Encode and verify one active resource once within its projection-scoped bounded LRU. */
  private resolveResourceBytes(projection: ReviewDocumentProjectionV1, resourceId: string) {
    const descriptor = projection.document.resources.find((resource) => resource.id === resourceId);
    if (
      !descriptor ||
      (descriptor.byteLength === undefined) !== (descriptor.digest === undefined)
    ) {
      throw new Error(`Review resource ${resourceId} has an invalid materialization descriptor.`);
    }
    if (descriptor.byteLength !== undefined && descriptor.byteLength > MAX_REVIEW_RESOURCE_BYTES) {
      throw new Error(`Review resource ${resourceId} is outside resource bounds.`);
    }
    let cache = this.encodedResourceBytes.get(projection);
    if (!cache) {
      cache = { entries: new Map(), totalBytes: 0 };
      this.encodedResourceBytes.set(projection, cache);
    }
    const cached = cache.entries.get(resourceId);
    if (cached) {
      cache.entries.delete(resourceId);
      cache.entries.set(resourceId, cached);
      return cached;
    }

    let encoded: CachedEncodedResource;
    if (descriptor.kind === "canonical-file") {
      const file = projection.document.files.find(
        (candidate) =>
          candidate.key === descriptor.fileKey && candidate.canonicalResourceId === resourceId,
      );
      if (!file) throw new Error(`Canonical review resource ${resourceId} has no matching file.`);
      encoded = encodeJsonStream(file, MAX_REVIEW_RESOURCE_BYTES);
      if (
        descriptor.byteLength !== undefined &&
        (encoded.byteLength !== descriptor.byteLength || encoded.digest !== descriptor.digest)
      ) {
        throw new Error(`Review resource ${resourceId} failed integrity verification.`);
      }
    } else {
      if (
        descriptor.byteLength === undefined ||
        descriptor.byteLength > MAX_REVIEW_RESOURCE_BYTES ||
        !descriptor.digest
      ) {
        throw new Error(`Review resource ${resourceId} is not materialized.`);
      }
      const text = projection.resourceContents[resourceId];
      if (text === undefined) throw new Error(`Review resource ${resourceId} is not materialized.`);
      const bytes = Buffer.from(text, "utf8");
      if (bytes.byteLength !== descriptor.byteLength || reviewDigest(bytes) !== descriptor.digest) {
        throw new Error(`Review resource ${resourceId} failed integrity verification.`);
      }
      encoded = { bytes, byteLength: bytes.byteLength, digest: descriptor.digest };
    }

    while (
      cache.entries.size > 0 &&
      cache.totalBytes + encoded.byteLength > MAX_ENCODED_RESOURCE_CACHE_BYTES
    ) {
      const oldestId = cache.entries.keys().next().value;
      if (oldestId === undefined) break;
      const retired = cache.entries.get(oldestId)!;
      cache.entries.delete(oldestId);
      cache.totalBytes -= retired.byteLength;
    }
    cache.entries.set(resourceId, encoded);
    cache.totalBytes += encoded.byteLength;
    return encoded;
  }

  /** Resolve one verified resource only from the active generation. */
  getResource(resourceId: string) {
    const { projection } = this.snapshot;
    const descriptor = projection.document.resources.find((resource) => resource.id === resourceId);
    if (!descriptor) return undefined;
    if (
      descriptor.kind !== "canonical-file" &&
      (descriptor.byteLength === undefined || descriptor.digest === undefined)
    )
      return undefined;
    return this.resolveResourceBytes(projection, resourceId).bytes.toString("utf8");
  }

  /** Expose active-generation encoded cache occupancy for diagnostics and benchmarks. */
  getEncodedResourceCacheStats() {
    const cache = this.encodedResourceBytes.get(this.snapshot.projection);
    return { entries: cache?.entries.size ?? 0, totalBytes: cache?.totalBytes ?? 0 };
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
    const previousWidth = this.rendererFields.noteMarkupWidth;
    this.rendererFields = fields;
    if (fields.noteMarkupWidth !== previousWidth) this.publishBrokerSnapshot(this.snapshot.store);
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

  /** Execute one renderer-neutral semantic intent against the current runtime authority. */
  executeReviewIntent = (
    intent: ReviewIntent,
    preconditions: ReviewIntentPreconditions = { mode: "current" },
  ): ReviewIntentExecution => {
    if (this.disposed) throw new Error("Review session runtime is disposed.");
    return this.executeReviewIntentInternal(intent, preconditions);
  };

  /** Compatibility wrapper that awaits runtime-owned materialization after the initial commit. */
  toggleSourceGap(fileKey: string, gapId: string) {
    if (this.disposed) return Promise.reject(new Error("Review session runtime is disposed."));
    try {
      const execution = this.executeReviewIntent({ type: "expansion/toggle", fileKey, gapId });
      return execution.effectCompletion ?? Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
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
        await this.reload("manual", this.currentRawInput, {
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
    // Local refreshes reapply config to the current authoritative raw invocation. Daemon
    // requests are explicit candidates and become authoritative only after successful publish.
    const requestedInput = request.reason === "daemon" ? request.input : this.currentRawInput;
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
      requestedInput,
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
    const nextState = store.getSnapshot();
    const selectedSemanticFile = nextState.document.files.find(
      (file) => file.key === nextState.selection.fileKey,
    );
    let nextSessionSnapshot: ReturnType<typeof createSessionSnapshotFromReviewState> | null = null;
    let nextRegistration: HunkSessionRegistration | null = null;
    let degradeToLocal = false;
    if (this.hostClient) {
      try {
        nextSessionSnapshot = createSessionSnapshotFromReviewState(nextState, this.rendererFields);
        nextRegistration = updateSessionRegistration(
          this.hostClient.getRegistration(),
          bootstrap,
          projection.document,
        );
        assertSessionRegistrationEnvelopeWithinBounds(nextRegistration, nextSessionSnapshot);
      } catch (error) {
        if (
          !(error instanceof ReviewProducerCapacityError) ||
          bootstrap.input.options.web ||
          reload.reason === "daemon"
        )
          throw error;
        // A manual/watch reload must preserve the original terminal contract even when the new
        // generation no longer fits optional broker metadata. Retire transport and continue local.
        degradeToLocal = true;
        nextSessionSnapshot = null;
        nextRegistration = null;
      }
    }
    const nextSnapshot: ReviewSessionRuntimeSnapshot = {
      revision: previousSnapshot.revision + 1,
      bootstrap,
      projection,
      store,
      extensions: reload.extensions,
      trust: { pendingRepoRoot, promptRepoRoot },
      notice: degradeToLocal
        ? "Session brokering is unavailable for this large review; reviewing locally."
        : previousSnapshot.notice,
      remountVersion: previousSnapshot.remountVersion + (reload.options.resetApp === false ? 0 : 1),
    };
    const result = {
      sessionId: nextRegistration?.sessionId ?? "local-session",
      inputKind: bootstrap.input.kind,
      title: bootstrap.changeset.title,
      sourceLabel: bootstrap.changeset.sourceLabel,
      fileCount: bootstrap.changeset.files.length,
      selectedFilePath: selectedSemanticFile?.path,
      selectedHunkIndex: nextState.selection.hunkIndex,
    } satisfies ReloadedSessionResult;
    this.assertCommandResultWithinBounds(result, "Reload result");
    if (this.hostClient && !degradeToLocal) {
      this.assertCommandResultWithinBounds(
        {
          kind: "review-snapshot",
          generation: projection.document.generation,
          manifest: createHunkReviewManifest(bootstrap, projection.document),
          state: createHunkReviewState(store.getSnapshot()),
        },
        "Review reconnect snapshot",
      );
    }
    if (this.disposed) throw new Error("Review session runtime is disposed.");

    // No active authority, registry, trust history, watch, or broker state changes before here.
    this.retireStoreAndCommandAuthority();
    if (degradeToLocal) {
      const retiredHost = this.hostClient;
      this.hostClient = undefined;
      this.lastBrokerPublicationKey = undefined;
      void Promise.resolve(retiredHost?.stop?.()).catch(() => undefined);
    }
    if (this.disposed) throw new Error("Review session runtime is disposed.");
    this.generationSequence = nextGenerationSequence;
    this.snapshot = nextSnapshot;
    if (reload.reloadedExtensions) this.extensionsCwd = reload.cwd;
    if (promptRepoRoot) this.offeredTrustRepoRoots.add(promptRepoRoot);
    if (reload.reloadedExtensions && previousSnapshot.extensions !== reload.extensions) {
      this.closeExtensionResult(previousSnapshot.extensions);
    }
    if (this.hostClient && nextRegistration && nextSessionSnapshot) {
      this.hostClient.replaceSession(nextRegistration, nextSessionSnapshot);
      this.lastBrokerPublicationKey = this.brokerPublicationKey(store.getSnapshot());
      this.hostClient.setBridge({
        dispatchCommand: (message) => this.dispatchSessionCommand(message),
      });
    }
    if (this.disposed) return result;
    // Promote a daemon invocation only after the complete generation and broker replacement publish.
    if (reload.reason === "daemon") this.currentRawInput = reload.requestedInput;

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
        await this.reload("watch", this.currentRawInput, {
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

  /** Identify the externally visible semantic and renderer fields mirrored to the broker. */
  private brokerPublicationKey(state: ReviewState) {
    return `${state.documentGeneration}\0${state.stateRevision}\0${this.rendererFields.noteMarkupWidth ?? ""}`;
  }

  /** Publish a semantic snapshot only when its broker-visible revision or width changed. */
  private publishBrokerSnapshot(store: ReviewStore) {
    if (this.disposed || store !== this.snapshot.store || !this.hostClient) return;
    const state = store.getSnapshot();
    const key = this.brokerPublicationKey(state);
    if (key === this.lastBrokerPublicationKey) return;
    const prepared = this.preparedBrokerSnapshots.get(state);
    const snapshot =
      prepared?.publicationKey === key
        ? prepared.snapshot
        : createSessionSnapshotFromReviewState(state, this.rendererFields);
    this.hostClient.updateSnapshot(snapshot);
    this.lastBrokerPublicationKey = key;
  }

  /** Subscribe broker publication only to externally visible store revisions. */
  private bindStore(store: ReviewStore) {
    this.storeSubscription = store.subscribePublished(() => this.publishBrokerSnapshot(store));
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

    const { projection } = this.snapshot;
    const descriptor = projection.document.resources.find(
      (resource) => resource.id === input.resourceId,
    );
    let encoded: CachedEncodedResource | undefined;
    try {
      encoded = this.resolveResourceBytes(projection, input.resourceId);
    } catch (error) {
      if (error instanceof JsonStreamSizeError) {
        return this.reviewCommandError(
          "resource-too-large",
          `Review resource ${input.resourceId} exceeds the producer resource limit.`,
        );
      }
    }
    if (!descriptor || !encoded) {
      return this.reviewCommandError(
        "unknown-resource",
        `Review resource ${input.resourceId} has no bounded materialized content.`,
      );
    }
    if (input.offset > encoded.byteLength) {
      return this.reviewCommandError("invalid-range", "Resource offset is outside its content.");
    }
    const end = Math.min(encoded.byteLength, input.offset + input.length);
    const chunk = encoded.bytes.subarray(input.offset, end);
    return {
      kind: "review-resource",
      generation: input.generation,
      id: input.resourceId,
      resourceId: input.resourceId,
      offset: input.offset,
      byteLength: chunk.byteLength,
      encoding: "base64",
      data: chunk.toString("base64"),
      contentDigest: encoded.digest,
      contentSize: encoded.byteLength,
      eof: end === encoded.byteLength,
    };
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

  /** Validate prospective revisions only while this runtime owns a broker producer. */
  private validateReviewStoreSnapshot(next: ReviewState) {
    // A terminal review may deliberately disable brokering or fall back locally after its initial
    // registration exceeds producer capacity. Broker bounds must never constrain that local UI.
    if (!this.hostClient) return;
    const publicationKey = this.brokerPublicationKey(next);
    const snapshot = createSessionSnapshotFromReviewState(next, this.rendererFields);
    assertReviewProducerEnvelopeWithinBounds(
      { type: "snapshot", snapshot },
      "Review snapshot update",
    );
    // The published listener receives this exact state object synchronously after validation, so
    // reuse its bounded projection rather than scanning note-heavy immutable metadata twice.
    this.preparedBrokerSnapshots.set(next, { publicationKey, snapshot });
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
  private commitReviewActions(actions: readonly ReviewAction[]) {
    const store = this.snapshot.store;
    const before = store.getSnapshot();
    const next = prepareReviewState(before, actions);
    return next === before ? before : store.commitPrepared(before, next);
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

  /** Enforce the caller's authority policy against one captured state snapshot. */
  private assertReviewIntentPreconditions(
    state: ReviewState,
    preconditions: ReviewIntentPreconditions,
  ) {
    if (
      preconditions.mode !== "current" &&
      preconditions.expectedGeneration !== state.documentGeneration
    ) {
      throw new Error("stale-generation");
    }
    if (
      preconditions.mode === "revision" &&
      preconditions.expectedStateRevision !== state.stateRevision
    ) {
      throw new Error("stale-revision");
    }
  }

  /** Return one opaque process-local identity for an exact source-fetcher object. */
  private sourceFetcherIdentity(fetcher: NonNullable<DiffFile["sourceFetcher"]>) {
    const existing = this.sourceFetcherIdentities.get(fetcher);
    if (existing) return existing;
    const identity = `fetcher:${++this.sourceFetcherIdentitySequence}`;
    this.sourceFetcherIdentities.set(fetcher, identity);
    return identity;
  }

  /** Prepare renderer-neutral facts without consuming identity until a commit succeeds. */
  private reviewIntentFacts(intent: ReviewIntent): {
    facts: ReviewIntentFacts;
    pendingUserNoteSequence?: number;
  } {
    if (intent.type === "expansion/toggle") {
      const fetcher = this.reviewFilePair(intent.fileKey)?.file.sourceFetcher;
      return {
        facts: fetcher ? { sourceFetcherIdentity: this.sourceFetcherIdentity(fetcher) } : {},
      };
    }
    if (intent.type !== "note/create-user" && intent.type !== "note/update-user") {
      return { facts: {} };
    }
    const now = this.deps.nowImpl();
    if (intent.type === "note/update-user") {
      return { facts: { timestamp: now.toISOString() } };
    }
    const pendingUserNoteSequence = this.userNoteSequence + 1;
    return {
      facts: {
        timestamp: now.toISOString(),
        noteId: `user:${now.getTime()}-${pendingUserNoteSequence}`,
      },
      pendingUserNoteSequence,
    };
  }

  /** Publish one canonical created-note event only after the committed identity is authoritative. */
  private emitCreatedUserNote(entry: ReviewStoredNote) {
    const semantic = this.snapshot.projection.document.files.find(
      (file) => file.key === entry.note.fileKey,
    );
    const preferred = entry.note.anchor.preferred;
    if (!semantic || !preferred) return;
    emitExtensionEvent(this.snapshot.extensions, "note_created", {
      note: {
        id: entry.note.id,
        fileId: semantic.runtimeId,
        filePath: semantic.path,
        hunkIndex: entry.note.anchor.ownerHunkIndex ?? 0,
        side: preferred.side,
        line: preferred.line,
        body: entry.note.summary,
        draft: false,
      },
    });
  }

  /** Revalidate every identity captured by one source-load effect against current authority. */
  private sourceEffectAuthority(
    effect: ReviewSourceLoadEffect,
    fetcher?: NonNullable<DiffFile["sourceFetcher"]>,
  ) {
    if (this.disposed) return undefined;
    const state = this.snapshot.store.getSnapshot();
    if (state.documentGeneration !== effect.generation) return undefined;
    const pair = this.reviewFilePair(effect.fileKey);
    const currentFetcher = pair?.file.sourceFetcher;
    if (
      !pair ||
      !currentFetcher ||
      (fetcher !== undefined && currentFetcher !== fetcher) ||
      this.sourceFetcherIdentities.get(currentFetcher) !== effect.sourceFetcherIdentity
    ) {
      return undefined;
    }
    const descriptor = this.snapshot.projection.document.resources.find(
      (resource) =>
        resource.id === effect.resourceId &&
        resource.kind === "source" &&
        resource.generation === effect.generation &&
        resource.fileKey === effect.fileKey &&
        resource.side === effect.side &&
        resource.sourceIdentity === effect.sourceIdentity,
    ) as ReviewSourceResourceDescriptorV1 | undefined;
    const gap = state.expandedGaps.find(
      (candidate) =>
        candidate.fileKey === effect.fileKey &&
        candidate.gapId === effect.gapId &&
        candidate.side === effect.side &&
        candidate.sourceIdentity === effect.sourceIdentity &&
        candidate.oldRange[0] === effect.oldRange[0] &&
        candidate.oldRange[1] === effect.oldRange[1] &&
        candidate.newRange[0] === effect.newRange[0] &&
        candidate.newRange[1] === effect.newRange[1],
    );
    return descriptor && gap ? { pair, fetcher: currentFetcher, descriptor } : undefined;
  }

  /** Publish an effect status only while its generation and backing authority remain exact. */
  private commitSourceEffectStatus(
    effect: ReviewSourceLoadEffect,
    fetcher: NonNullable<DiffFile["sourceFetcher"]>,
    status: ReviewState["sourceStatusByFileKey"][string],
  ) {
    if (!this.sourceEffectAuthority(effect, fetcher)) return false;
    this.commitReviewActions([
      {
        type: "expansion/set-source-status",
        expectedGeneration: effect.generation,
        fileKey: effect.fileKey,
        status,
      },
    ]);
    return true;
  }

  /** Materialize one source resource and publish completion without leaking retired bytes. */
  private startSourceLoadEffect(effect: ReviewSourceLoadEffect) {
    const authority = this.sourceEffectAuthority(effect);
    if (!authority) return Promise.resolve();
    const { fetcher } = authority;
    const loadKey = `${effect.generation}\0${effect.fileKey}\0${effect.side}`;
    const existing = this.sourceLoads.get(loadKey);
    if (existing) return existing;

    let source: ReturnType<typeof fetcher.getFullText>;
    try {
      source = fetcher.getFullText(effect.side);
    } catch (error) {
      source = Promise.reject(error);
    }
    const load = Promise.resolve(source)
      .then((text) => {
        const current = this.sourceEffectAuthority(effect, fetcher);
        if (!current) return;
        if (text === null) {
          this.commitSourceEffectStatus(effect, fetcher, { kind: "error" });
          return;
        }
        const byteLength = Buffer.byteLength(text, "utf8");
        if (byteLength > MAX_REVIEW_SOURCE_RESOURCE_BYTES) {
          throw new SourceTextTooLargeError(MAX_REVIEW_SOURCE_RESOURCE_BYTES);
        }
        const { descriptor } = current;
        const contents = this.snapshot.projection.resourceContents;
        const hadByteLength = descriptor.byteLength !== undefined;
        const previousByteLength = descriptor.byteLength;
        const hadDigest = descriptor.digest !== undefined;
        const previousDigest = descriptor.digest;
        const hadContent = Object.hasOwn(contents, descriptor.id);
        const previousContent = contents[descriptor.id];
        descriptor.byteLength = byteLength;
        descriptor.digest = reviewDigest(text);
        contents[descriptor.id] = text;
        const rollback = () => {
          if (hadByteLength) descriptor.byteLength = previousByteLength;
          else delete descriptor.byteLength;
          if (hadDigest) descriptor.digest = previousDigest;
          else delete descriptor.digest;
          if (hadContent) contents[descriptor.id] = previousContent!;
          else delete contents[descriptor.id];
        };
        try {
          if (!this.commitSourceEffectStatus(effect, fetcher, { kind: "loaded", text })) {
            rollback();
          }
        } catch (error) {
          rollback();
          throw error;
        }
      })
      .catch((error: unknown) => {
        if (!this.sourceEffectAuthority(effect, fetcher)) return;
        if (!(error instanceof SourceTextTooLargeError)) {
          const pair = this.reviewFilePair(effect.fileKey);
          console.error(
            `hunk: failed to load ${effect.side} source for ${pair?.file.path ?? effect.fileKey} (${pair?.file.id ?? effect.fileKey}).`,
            error,
          );
        }
        try {
          this.commitSourceEffectStatus(effect, fetcher, {
            kind: "error",
            ...(error instanceof SourceTextTooLargeError ? { reason: "too-large" as const } : {}),
          });
        } catch (statusError) {
          console.error("hunk: failed to publish expanded source error state.", statusError);
        }
      })
      .finally(() => {
        if (this.sourceLoads.get(loadKey) === load) this.sourceLoads.delete(loadKey);
      });
    this.sourceLoads.set(loadKey, load);
    return load;
  }

  /** Start only typed runtime effects after their complete semantic batch has committed. */
  private startReviewIntentEffects(effects: readonly ReviewIntentEffect[] | undefined) {
    if (!effects?.length) return undefined;
    return Promise.all(effects.map((effect) => this.startSourceLoadEffect(effect))).then(
      () => undefined,
    );
  }

  /** Reuse an owned in-flight source load when another gap joins the same source authority. */
  private pendingExpansionEffectCompletion(intent: ReviewIntent, state: ReviewState) {
    if (intent.type !== "expansion/toggle") return undefined;
    const gap = state.expandedGaps.find(
      (candidate) =>
        candidate.fileKey === intent.fileKey &&
        candidate.gapId === intent.gapId &&
        candidate.expanded,
    );
    if (!gap || state.sourceStatusByFileKey[intent.fileKey]?.kind !== "loading") return undefined;
    return this.sourceLoads.get(`${state.documentGeneration}\0${intent.fileKey}\0${gap.side}`);
  }

  /** Plan, preflight, and commit one semantic intent before running post-commit effects. */
  private executeReviewIntentInternal(
    intent: ReviewIntent,
    preconditions: ReviewIntentPreconditions,
    options: { preflightActionResult?: boolean } = {},
  ): ReviewIntentExecution {
    if (this.disposed) throw new Error("Review session runtime is disposed.");
    const store = this.snapshot.store;
    const before = store.getSnapshot();
    this.assertReviewIntentPreconditions(before, preconditions);
    const { facts, pendingUserNoteSequence } = this.reviewIntentFacts(intent);
    const plan = planReviewIntent(before, intent, facts);
    if (intent.type === "note/create-user" && !intent.consumeDraft) {
      this.reviewMarkupFeedback(intent.markup);
    } else if (intent.type === "note/update-user") {
      this.reviewMarkupFeedback(intent.markup);
    }
    const prepared = prepareReviewState(before, plan.actions);
    if (prepared === before) return { before, state: before, changed: false };
    if (options.preflightActionResult) {
      this.assertCommandResultWithinBounds(
        {
          kind: "review-action",
          generation: prepared.documentGeneration,
          stateRevision: prepared.stateRevision,
          state: createHunkReviewState(prepared),
        },
        "Review action result",
      );
    }
    const state = store.commitPrepared(before, prepared);
    if (pendingUserNoteSequence !== undefined) {
      this.userNoteSequence = pendingUserNoteSequence;
    }
    const plannedCreatedId =
      plan.outcome?.type === "note/created" ? plan.outcome.note.note.id : undefined;
    const createdNote = plannedCreatedId
      ? state.userNotes.find((entry) => entry.note.id === plannedCreatedId)
      : undefined;
    if (createdNote) this.emitCreatedUserNote(createdNote);
    if (intent.type === "note/remove-live") this.releaseSessionCommentIdentity(intent.noteId);
    const effectCompletion =
      this.startReviewIntentEffects(plan.effects) ??
      this.pendingExpansionEffectCompletion(intent, state);
    return {
      before,
      state,
      changed: true,
      ...(createdNote ? { createdNote } : {}),
      ...(effectCompletion ? { effectCompletion } : {}),
    };
  }

  /** Preserve established browser-facing messages while adopting stricter semantic failures. */
  private browserIntentErrorMessage(action: HunkReviewActionV1, error: unknown) {
    if (!(error instanceof ReviewIntentPlanningError)) {
      return error instanceof Error ? error.message : "Review action failed.";
    }
    if (action.type === "notes/create-user") {
      if (error.code === "file-not-found") return "The selected review file no longer exists.";
      if (error.code === "hunk-not-found") return "The selected review hunk no longer exists.";
    }
    if (
      action.type === "notes/remove-live" &&
      (error.code === "note-not-found" || error.code === "note-not-editable")
    ) {
      return `Live note ${action.noteId} cannot be removed.`;
    }
    return error.message;
  }

  /** Convert one validated browser DTO into a semantic intent or explicit runtime action. */
  private browserActionIntent(action: HunkReviewActionV1): ReviewIntent | "runtime" {
    switch (action.type) {
      case "selection/select": {
        const { fileKey, hunkIndex, side, line } = action.selection;
        if (fileKey === null) throw new Error("The selected review file no longer exists.");
        if ((side === undefined) !== (line === undefined)) {
          throw new Error("Review selection side and line must be provided together.");
        }
        return {
          type: "selection/select",
          fileKey,
          hunkIndex,
          ...(side !== undefined && line !== undefined ? { line: { side, line } } : {}),
          ...(action.reveal ? { reveal: action.reveal } : {}),
        };
      }
      case "selection/set-line":
        return {
          type: "selection/set-line",
          fileKey: action.fileKey,
          hunkIndex: action.hunkIndex,
          side: action.side,
          line: action.line,
          ...(action.reveal === undefined ? {} : { reveal: action.reveal }),
        };
      case "filter/set":
        return action;
      case "notes/set-visibility":
        return action;
      case "notes/create-user":
        return { type: "note/create-user", ...action.note };
      case "notes/update-user":
        return {
          type: "note/update-user",
          noteId: action.noteId,
          body: action.body,
          ...(action.markup === undefined ? {} : { markup: action.markup }),
        };
      case "notes/remove-user":
        return { type: "note/remove-user", noteId: action.noteId };
      case "notes/remove-live":
        return { type: "note/remove-live", noteId: action.noteId };
      case "expansion/toggle":
        return action;
      case "session/reload":
      case "trust/decide":
        return "runtime";
      default:
        return assertNever(action, "browser review action");
    }
  }

  /** Apply only a strictly validated generation- and revision-guarded semantic action. */
  private async applyReviewAction(input: ApplyReviewActionInput): Promise<HunkReviewCommandResult> {
    if (typeof input.generation !== "string" || input.generation.length === 0) {
      return this.reviewCommandError("invalid-generation", "Action generation is required.");
    }
    const targetError = this.validateReviewCommandTarget(input.sessionId, input.generation);
    if (targetError) return targetError;
    const action = parseHunkReviewActionV1(input.action);
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
      const intent = this.browserActionIntent(action);
      if (intent !== "runtime") {
        const execution = this.executeReviewIntentInternal(
          intent,
          selectionAction
            ? { mode: "generation", expectedGeneration: input.generation }
            : {
                mode: "revision",
                expectedGeneration: input.generation,
                expectedStateRevision: input.expectedStateRevision!,
              },
          { preflightActionResult: true },
        );
        await execution.effectCompletion;
      } else {
        switch (action.type) {
          case "session/reload":
            if (!canReloadInput(this.snapshot.bootstrap.input))
              throw new Error("This review cannot be reloaded.");
            await this.reload("manual", this.currentRawInput, {
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
        }
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
        this.browserIntentErrorMessage(action, error),
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
          note.anchor.intersectingHunkIndices.map((hunkIndex) => `${note.fileKey}\0${hunkIndex}`),
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
      // Annotated navigation is non-cyclic, matching terminal hunk navigation at both edges.
      const target =
        input.commentDirection === "next"
          ? (annotated.find((candidate) => compareToSelection(candidate) > 0) ?? annotated.at(-1)!)
          : ([...annotated].reverse().find((candidate) => compareToSelection(candidate) < 0) ??
            annotated[0]!);
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

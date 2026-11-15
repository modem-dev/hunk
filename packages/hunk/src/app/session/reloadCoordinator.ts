/**
 * Replaces the content of one mounted review session, one reload at a time.
 *
 * The `r` key and File → Reload, `--watch` change events, completed extension workspace writes,
 * extension reload requests, and the agent's `hunk session reload` (the same input, or a new one
 * within the session's reload bounds) all converge here. The coordinator serializes overlapping
 * reloads, refuses every reload once shutdown begins, resolves configuration and extensions for
 * the next input, loads it through `app/sessionBootstrap.ts`, advances the producer's
 * generation, and keeps the broker registration aligned with the review about to mount.
 *
 * Ordering: a reload commits in one synchronous step — new registry adoption, broker
 * registration and snapshot, producer publication (with the previous store detached), and the
 * surface's adoption — so quit linearizes wholly before or after it, and a failure anywhere
 * before that step leaves the old review mounted and published. The queue stays held until the
 * surface reports the replacement mounted, so lifecycle handlers always see controls leased to
 * the review generation they describe.
 *
 * What it leaves to the surface: how the replacement is mounted (`adopt` — a React commit in the
 * terminal, `host.replaceFiles` headless), live view preferences and theme state, notices, and
 * any commit gate a renderer needs. It imports nothing from a renderer.
 */
import type {
  ExtensionReviewReloadResult,
  NamedCustomThemeConfig,
} from "../../extension-api/types";
import type { AppBootstrap } from "../../core/bootstrap";
import { restoreFileLanguageRegistrations } from "../../core/documents/fileLanguage";
import { resolveRuntimeCliInput } from "../../core/process/terminal";
import { resolveConfiguredCliInput } from "../../core/run/config";
import type { CliInput, CommonOptions } from "../../core/run/commandInputs";
import type { ReviewRefreshRequest } from "../../core/run/reviewRefresh";
import { extendVcsCatalog } from "../../core/vcs";
import { assertReliableWatchRuntime } from "../../core/watch/runtime";
import {
  createUnknownVcsNotice,
  reportExtensionApplyIssues,
  resolveExtensionVcsAdapters,
} from "../../extensions/apply";
import { emitExtensionEvent } from "../../extensions/events";
import type { ExtensionSession } from "../../extensions/session";
import type { ExtensionLoadResult } from "../../extensions/types";
import type { HunkSessionBrokerClient } from "../../session/broker/brokerClient";
import type { ReloadedSessionResult, ReloadSessionOptions } from "../../session/types";
import { reviewDescriptorAfterReload, reviewDescriptorResourceCwd } from "../delegatedReview";
import { resolveConfiguredExtensions } from "../extensionBootstrap";
import { ReviewProducer } from "../review/producer";
import { loadConfiguredSessionBootstrap } from "../sessionBootstrap";
import { getBundledVcsCatalog } from "../vcsCatalog";
import { createSessionReloadBounds, validateSessionReloadWithinBounds } from "./reloadBounds";
import { createInitialSessionSnapshot, updateSessionRegistration } from "./registration";

export type { ReviewRefreshRequest };

/** One loaded and published replacement the surface must now mount. */
export interface ReviewReloadAdoption {
  bootstrap: AppBootstrap;
  /** False keeps the mounted review state (a soft reload); true remounts it. */
  resetApp: boolean;
  /** Custom themes the replacement resolved, for the surface's theme state. */
  customThemes: readonly NamedCustomThemeConfig[];
  /**
   * Emit the extension lifecycle for the mounted replacement, once its controls are live.
   *
   * Absent when no extension registry is active; the reload then does not wait for a mount.
   */
  runMountedLifecycle?: () => void;
}

export interface ReviewReloadCoordinatorOptions {
  /** The launch bootstrap, with its reload catalog resolved. */
  bootstrap: AppBootstrap;
  /** The producer whose generations this session publishes; created when absent. */
  producer?: ReviewProducer;
  hostClient?: HunkSessionBrokerClient;
  extensionSession: ExtensionSession;
  /** Whether the bootstrap carries an extension result whose lifecycle this session runs. */
  extensionLifecycleEnabled: boolean;
  /** Whether this surface may adopt a replacement registry. */
  extensionOwnership: "owned" | "borrowed";
  /** Reload content without rediscovering a status-owned session's launch configuration. */
  retainLaunchConfig?: boolean;
  /** Keep the owning session's custom palettes across source-target reloads. */
  sessionCustomThemes?: AppBootstrap["customThemes"];
  /** Runtime identity injection for reload compatibility tests. */
  bunVersion?: string;
  /**
   * Options a retained-launch reload starts from: the launch bootstrap with the current input,
   * plus whatever live view preferences the surface holds.
   */
  retainedLaunchOptions?: (launch: AppBootstrap) => CommonOptions;
  /** Mount one published replacement; resolve once its lifecycle has run. */
  adopt: (adoption: ReviewReloadAdoption) => Promise<void> | void;
}

/** Build the stable refusal returned once quit becomes terminal for reload coordination. */
export function reloadRefusedDuringShutdown() {
  return new Error("The review session is shutting down and cannot reload.");
}

/** Describe a host reload failure without assuming it is an Error instance. */
function describeExtensionReloadFailure(error: unknown) {
  const detail = error instanceof Error ? error.message || error.name : String(error);
  return `Failed to reload the current review: ${detail}`;
}

/** Keep absent CLI flags from clearing a retained effective option, including explicit false values. */
function definedReviewOptions(options: CommonOptions): CommonOptions {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

/** Fill the bundled VCS catalog into a bootstrap that was launched without one. */
export function withReloadVcsCatalog(bootstrap: AppBootstrap): AppBootstrap {
  return bootstrap.reloadContext.vcsCatalog
    ? bootstrap
    : {
        ...bootstrap,
        reloadContext: { ...bootstrap.reloadContext, vcsCatalog: getBundledVcsCatalog() },
      };
}

export class ReviewReloadCoordinator {
  /** The producer whose generation advances with every committed reload. */
  readonly producer: ReviewProducer;
  private readonly options: ReviewReloadCoordinatorOptions;
  private readonly launchBootstrap: AppBootstrap;
  private readonly sessionFileBounds: ReturnType<typeof createSessionReloadBounds>;
  private reloadTail: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private readonly pendingWorkspaceWrites = new Set<Promise<void>>();
  private refreshRequest: ReviewRefreshRequest | undefined;
  private pendingExtensionReload:
    | { reviewGeneration: AppBootstrap; promise: Promise<ExtensionReviewReloadResult> }
    | undefined;
  private reviewIdentity: {
    input: CliInput;
    cwd: string;
    review: AppBootstrap["review"];
    preserveReviewOnReload: boolean;
  };
  private currentBootstrap: AppBootstrap;

  constructor(options: ReviewReloadCoordinatorOptions) {
    this.options = options;
    const bootstrap = options.bootstrap;
    this.launchBootstrap = bootstrap;
    this.currentBootstrap = bootstrap;
    this.producer =
      options.producer ??
      new ReviewProducer({
        files: bootstrap.changeset.files,
        sourceLabel: bootstrap.changeset.sourceLabel,
      });
    this.sessionFileBounds = createSessionReloadBounds(bootstrap, {
      cwd: bootstrap.reloadContext.cwd,
    });
    this.reviewIdentity = {
      input: bootstrap.input,
      cwd: reviewDescriptorResourceCwd(
        bootstrap.input,
        bootstrap.reloadContext.cwd,
        bootstrap.reloadContext.repoRoot,
      ),
      review: bootstrap.review,
      preserveReviewOnReload:
        bootstrap.review !== undefined && bootstrap.reviewSource !== "provider",
    };
  }

  /** The bootstrap of the review most recently handed to the surface. */
  getBootstrap(): AppBootstrap {
    return this.currentBootstrap;
  }

  /** Whether shutdown has begun; every later reload is refused. */
  isShuttingDown() {
    return this.shuttingDown;
  }

  /**
   * Start the launch review's extension lifecycle once its controls are live.
   *
   * An owned session starts its registry at the launch cwd; every session announces the loaded
   * changeset.
   */
  runInitialLifecycle() {
    const { extensionLifecycleEnabled, extensionOwnership, extensionSession } = this.options;
    if (extensionLifecycleEnabled && extensionOwnership === "owned") {
      extensionSession.startCurrent(this.launchBootstrap.reloadContext.cwd);
    }
    emitExtensionEvent(
      extensionLifecycleEnabled ? extensionSession.current : undefined,
      "changeset_loaded",
      { changeset: this.launchBootstrap.changeset },
    );
  }

  /** Serialize one reload behind every earlier one; refused once shutdown has begun. */
  reload(nextInput: CliInput, options?: ReloadSessionOptions): Promise<ReloadedSessionResult> {
    return this.enqueue(() => {
      if (this.shuttingDown) throw reloadRefusedDuringShutdown();
      return this.performReload(nextInput, options);
    });
  }

  /**
   * Keep the latest mounted refresh descriptor without letting stale cleanup clear its successor.
   */
  registerRefreshRequest(request: ReviewRefreshRequest): () => void {
    this.refreshRequest = request;
    return () => {
      if (this.refreshRequest === request) {
        this.refreshRequest = undefined;
      }
    };
  }

  /** Start one irreversible write atomically with session tracking, unless quit already won. */
  async runWorkspaceWrite(write: () => Promise<void>): Promise<boolean> {
    if (this.shuttingDown) return false;
    const pending = write();
    this.pendingWorkspaceWrites.add(pending);
    try {
      await pending;
      return true;
    } finally {
      this.pendingWorkspaceWrites.delete(pending);
    }
  }

  /** Reconcile a completed write against whichever review owns the queue when it reaches the front. */
  reloadAfterWorkspaceWrite() {
    void this.enqueue(async () => {
      if (this.shuttingDown) return;
      const request = this.refreshRequest;
      if (!request) return;
      await this.performReload(request.nextInput, {
        reason: "manual",
        resetApp: false,
        sourcePath: request.sourcePath,
      });
    }).catch((error) => {
      console.error("Failed to reload after an extension workspace write.", error);
    });
  }

  /** Coalesce extension requests and resolve their descriptor at the front of the queue. */
  requestExtensionReviewReload(
    reviewGeneration: AppBootstrap,
  ): Promise<ExtensionReviewReloadResult> {
    const existing = this.pendingExtensionReload;
    if (existing?.reviewGeneration === reviewGeneration) return existing.promise;

    const promise = this.enqueue(async (): Promise<ExtensionReviewReloadResult> => {
      if (this.shuttingDown) {
        return {
          ok: false,
          reason: "unavailable",
          detail: "The review session is shutting down and cannot reload.",
        };
      }
      const request = this.refreshRequest;
      if (!request) {
        return {
          ok: false,
          reason: "unavailable",
          detail: "The current review cannot be reloaded from its original input.",
        };
      }

      try {
        await this.performReload(request.nextInput, {
          reason: "extension",
          resetApp: false,
          sourcePath: request.sourcePath,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: "failed", detail: describeExtensionReloadFailure(error) };
      }
    });
    const pending = { reviewGeneration, promise };
    this.pendingExtensionReload = pending;
    void promise.finally(() => {
      if (this.pendingExtensionReload === pending) {
        this.pendingExtensionReload = undefined;
      }
    });
    return promise;
  }

  /**
   * Make shutdown terminal for reload coordination.
   *
   * Returns false when shutdown had already begun, so the caller runs its teardown once.
   */
  beginShutdown(): boolean {
    if (this.shuttingDown) return false;
    this.shuttingDown = true;
    return true;
  }

  /** Wait for every workspace write started before shutdown to settle. */
  settleStartedWrites(): Promise<unknown> {
    return Promise.allSettled(this.pendingWorkspaceWrites);
  }

  /** Append one operation to the reload queue. */
  private enqueue<Result>(run: () => Promise<Result>): Promise<Result> {
    const pending = this.reloadTail.then(run);
    this.reloadTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  /** Load, publish, and hand one replacement review to the surface. */
  private async performReload(
    nextInput: CliInput,
    options?: ReloadSessionOptions,
  ): Promise<ReloadedSessionResult> {
    if (this.shuttingDown) throw reloadRefusedDuringShutdown();
    const {
      extensionLifecycleEnabled,
      extensionOwnership,
      extensionSession,
      hostClient,
      retainLaunchConfig = false,
      sessionCustomThemes,
    } = this.options;
    const launchBootstrap = this.launchBootstrap;
    const launchOptions = launchBootstrap.input.options;

    // Ordinary reviews rediscover config; status-owned reviews retain launch authority.
    // Caller options still override the effective baseline, while sourcePath independently
    // chooses the content cwd. Live preferences also seed bare broker reloads. Experimental
    // and extension authority are launch authority: a reload command names *content* to
    // reopen and is parsed fresh, so the launch flags are re-threaded raw — `undefined` keeps
    // deferring to the config layers rather than becoming an explicit choice.
    const runtimeInput = resolveRuntimeCliInput({
      ...nextInput,
      options: {
        ...(retainLaunchConfig
          ? (this.options.retainedLaunchOptions?.({
              ...launchBootstrap,
              input: this.reviewIdentity.input,
            }) ?? this.reviewIdentity.input.options)
          : {}),
        ...(retainLaunchConfig ? definedReviewOptions(nextInput.options) : nextInput.options),
        experimental: launchOptions.experimental === true,
        extensions: launchOptions.extensions,
        extensionPaths: launchOptions.extensionPaths,
        extensionSelectionOverrides: launchOptions.extensionSelectionOverrides,
      },
    });
    const { cwd } = validateSessionReloadWithinBounds(this.sessionFileBounds, runtimeInput, {
      sourcePath: options?.sourcePath,
    });
    const baseVcsCatalog = getBundledVcsCatalog();
    const currentExtensions = extensionLifecycleEnabled ? extensionSession.current : undefined;
    const currentAdapters = currentExtensions
      ? resolveExtensionVcsAdapters(currentExtensions.registry, baseVcsCatalog).adapters
      : [];
    const discoveryCatalog = extendVcsCatalog(baseVcsCatalog, currentAdapters);
    let configured = retainLaunchConfig
      ? {
          input: runtimeInput,
          customThemes: [...(sessionCustomThemes ?? launchBootstrap.customThemes ?? [])],
          // Borrowed reviews never rediscover extension selection; the owner supplies it below.
          extensions: { enabled: false, paths: [], repoPaths: [], extensionConfigs: {} },
          keybindings: launchBootstrap.keybindings ?? {},
          feedbackEnabled: launchBootstrap.feedbackEnabled ?? true,
          explicitVcsId: runtimeInput.options.vcs,
          viewPreferencesConfigPath: launchBootstrap.viewPreferencesConfigPath,
          startupNotices: launchBootstrap.startupNotices,
        }
      : resolveConfiguredCliInput(runtimeInput, { cwd, vcsCatalog: discoveryCatalog });
    if (configured.input.options.watch) {
      assertReliableWatchRuntime(this.options.bunVersion ?? Bun.version);
    }
    let replacementExtensions: ExtensionLoadResult | undefined;

    if (
      extensionOwnership === "owned" &&
      (options?.reloadExtensions || cwd !== extensionSession.cwd)
    ) {
      try {
        const resolvedExtensions = await resolveConfiguredExtensions({
          runtimeInput,
          configured,
          cwd,
          baseVcsCatalog,
          discoveryCatalog,
          // Reuse the session hub so the mounted toast surface keeps receiving notifications.
          notifications: currentExtensions?.notifications,
          onProvisionalLoad: (result) => extensionSession.trackPrepared(result),
          assertActive: () => {
            if (this.shuttingDown) throw reloadRefusedDuringShutdown();
          },
        });
        configured = resolvedExtensions.configured;
        replacementExtensions = resolvedExtensions.extensions;
        extensionSession.trackPrepared(replacementExtensions);
      } catch (error) {
        // The resolver may fail after publishing a provisional registry but before returning
        // it. Clear session ownership through the same shared retirement used by quit and the
        // ordinary reload failure paths.
        await extensionSession.retirePrepared();
        throw error;
      }
      if (this.shuttingDown) {
        await extensionSession.retirePrepared(replacementExtensions);
        throw reloadRefusedDuringShutdown();
      }
    }

    const extensions = replacementExtensions ?? currentExtensions;
    let loaded: Awaited<ReturnType<typeof loadConfiguredSessionBootstrap>>;
    try {
      loaded = await loadConfiguredSessionBootstrap({
        configured,
        cwd,
        extensions,
        sessionCustomThemes,
        loadAtCwd: true,
        baseVcsCatalog,
      });
    } catch (error) {
      await extensionSession.retirePrepared(replacementExtensions);
      throw error;
    }

    // This is the reload's commit gate. Nothing below awaits until the new registry, broker
    // snapshot, mount request, and surface state all agree. Quit therefore linearizes either
    // wholly before or wholly after adoption.
    if (this.shuttingDown) {
      restoreFileLanguageRegistrations(loaded.previousFileLanguages);
      await extensionSession.retirePrepared(replacementExtensions);
      throw reloadRefusedDuringShutdown();
    }

    let nextBootstrap!: AppBootstrap;
    let nextReviewCwd!: string;
    let nextSnapshot!: ReturnType<typeof createInitialSessionSnapshot>;
    let sessionId = "local-session";
    try {
      const { applied, bootstrap, input: reloadInput, sessionVcs } = loaded;
      nextBootstrap = bootstrap;
      nextReviewCwd = reviewDescriptorResourceCwd(
        nextBootstrap.input,
        cwd,
        nextBootstrap.reloadContext.repoRoot,
      );
      const preservedReview = this.reviewIdentity.preserveReviewOnReload
        ? reviewDescriptorAfterReload(
            this.reviewIdentity.input,
            this.reviewIdentity.cwd,
            this.reviewIdentity.review,
            nextBootstrap.input,
            nextReviewCwd,
          )
        : undefined;
      if (preservedReview) {
        nextBootstrap.review = preservedReview;
        nextBootstrap.reviewSource = "caller";
      }
      if (extensions) {
        reportExtensionApplyIssues(applied.issues, extensions.context);
      }
      nextBootstrap.startupNotices =
        sessionVcs.unknownVcsId !== undefined
          ? [
              ...(configured.startupNotices ?? []),
              // Names the backend the reload really used, detection override included.
              createUnknownVcsNotice(sessionVcs.unknownVcsId, String(reloadInput.options.vcs)),
            ]
          : configured.startupNotices;
      const preparedPublication = this.producer.preparePublication({
        files: nextBootstrap.changeset.files,
        sourceLabel: nextBootstrap.changeset.sourceLabel,
      });
      nextSnapshot = createInitialSessionSnapshot(nextBootstrap, preparedPublication.publication);
      const publicationReservation = this.producer.reservePublication(preparedPublication);
      try {
        if (hostClient) {
          // Keep the daemon-facing registration aligned with the review about to mount.
          const nextRegistration = updateSessionRegistration(
            hostClient.getRegistration(),
            nextBootstrap,
            preparedPublication.publication,
          );
          sessionId = nextRegistration.sessionId;
          hostClient.replaceSession(nextRegistration, nextSnapshot);
        }
        // The matching review store does not exist yet. Detach the previous generation so
        // broker commands refuse rather than mutate stale state until the surface attaches the
        // committed review.
        publicationReservation.commit({ detachStore: true });
      } catch (error) {
        publicationReservation.cancel();
        throw error;
      }
    } catch (error) {
      restoreFileLanguageRegistrations(loaded.previousFileLanguages);
      await extensionSession.retirePrepared(replacementExtensions);
      throw error;
    }

    let currentExtensionsRetired: Promise<void> | undefined;
    if (replacementExtensions) {
      // Adopt only after the review and broker publication are known-good. Adoption revokes
      // the previous registry synchronously before exposing the replacement.
      currentExtensionsRetired = extensionSession.adoptPrepared(replacementExtensions, cwd);
    }

    const changeset = nextBootstrap.changeset;
    const reason = options?.reason ?? "daemon";
    const emitStartup = replacementExtensions !== undefined;
    this.reviewIdentity = {
      input: nextBootstrap.input,
      cwd: nextReviewCwd,
      review: nextBootstrap.review,
      preserveReviewOnReload:
        nextBootstrap.review !== undefined && nextBootstrap.reviewSource !== "provider",
    };
    this.currentBootstrap = nextBootstrap;
    const reloadMounted = this.options.adopt({
      bootstrap: nextBootstrap,
      resetApp: options?.resetApp !== false,
      customThemes: loaded.initialization.theme.customThemes,
      runMountedLifecycle: extensions
        ? () => {
            if (emitStartup) {
              extensionSession.startCurrent(cwd);
            }
            emitExtensionEvent(extensions, "changeset_loaded", { changeset });
            emitExtensionEvent(extensions, "session_reload", { changeset, reason });
          }
        : undefined,
    });

    // Keep the reload queue held until the surface mounts the matching review and lifecycle
    // handlers receive controls leased to that review generation.
    await Promise.all([reloadMounted, currentExtensionsRetired]);

    return {
      sessionId,
      inputKind: nextBootstrap.input.kind,
      title: nextBootstrap.changeset.title,
      sourceLabel: nextBootstrap.changeset.sourceLabel,
      fileCount: nextBootstrap.changeset.files.length,
      selectedFilePath: nextSnapshot.state.selectedFilePath,
      selectedHunkIndex: nextSnapshot.state.selectedHunkIndex,
    };
  }
}

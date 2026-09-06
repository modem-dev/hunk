/**
 * Hunk's broker state: the generic session broker plus this app's review mirror.
 *
 * The generic core (`@hunk/session-broker-core`) knows how to hold sessions, route
 * commands, and prune the dead. What it deliberately does not know is that a Hunk session
 * publishes a *review*, in generations, with resources attached. That is added here:
 *
 * - The **mirror** (`reviewMirror.ts`) records which generation each session serves and
 *   what it offers there, ordered by the one shared classifier.
 * - The **resource path** reads those resources through one bounded, verified loop —
 *   single-flight per resource, reserved against a daemon-wide in-flight budget, and
 *   assembled by the shared `ReviewChunkAssembler`. There is one such loop, not one per
 *   caller: the prototype had two near-identical copies inside this file, already
 *   disagreeing about progress and end-of-stream rules
 *   (`docs/browser-review-seam-audit.md`, C2).
 * - **Action forwarding** hands a parsed review action to the producer that owns the
 *   review state, which plans it through the same intent path the terminal uses. The
 *   daemon never interprets an action, and in particular never re-derives where a note
 *   hangs — that is core's answer, reached at the producer (D3).
 */
import {
  buildHunkSessionReview,
  buildListedHunkSession,
  buildSelectedHunkSessionContext,
  listHunkSessionComments,
} from "./projections";
import type {
  HunkSessionCommandResult,
  HunkSessionInfo,
  HunkSessionServerMessage,
  HunkSessionState,
  ListedSession,
  SelectedSessionContext,
  SessionLiveCommentSummary,
  SessionReview,
  SessionReviewFile,
} from "../types";
import { hunkSessionProtocolParsers } from "./protocolParsers";
import { parseSessionRegistration, parseSessionSnapshot } from "./wire";
import {
  ReviewMirror,
  readRegistrationReviewCatalog,
  readSnapshotReviewPublication,
  type MirroredReviewPublication,
} from "./reviewMirror";
import { ReviewResourceCache, type ReviewResourceReservation } from "./reviewResourceCache";
import { ReviewChunkAssembler } from "../../core/review/resourceAssembly";
import {
  isMaterializedReviewResource,
  REVIEW_RESOURCE_CHUNK_BYTES,
  REVIEW_RESOURCE_LOAD_CONCURRENCY,
  reviewResourceCeiling,
  reviewResourceId,
  type ReviewResourceDescriptorV1,
} from "../../core/review/resources";
import { isReviewSha256Digest } from "../../core/review/validation";
import { nodeReviewDigest } from "../../core/reviewDigest";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  type HunkReviewActionResultV1,
  type HunkReviewActionV1,
  type HunkReviewActorV1,
  type HunkReviewFailureCodeV1,
  type HunkReviewResourceReadResultV1,
} from "../reviewProtocol";
import {
  SessionBrokerState,
  type SessionBrokerViewAdapter,
  type SessionTargetInput,
} from "@hunk/session-broker-core";
import { reviewResourceUnavailableMessage } from "../agent/errors";

const hunkSessionBrokerView: SessionBrokerViewAdapter<
  HunkSessionInfo,
  HunkSessionState,
  ListedSession,
  SelectedSessionContext,
  SessionReview,
  SessionLiveCommentSummary,
  HunkSessionServerMessage,
  HunkSessionCommandResult
> = {
  parseRegistration: parseSessionRegistration,
  parseSnapshot: parseSessionSnapshot,
  parseCommandInput: (command, version, value) =>
    hunkSessionProtocolParsers.parseCommandInput(command, version, value),
  parseCommandResult: (command, version, value) =>
    hunkSessionProtocolParsers.parseCommandResult(command, version, value),
  buildListedSession: buildListedHunkSession,
  buildSelectedContext: buildSelectedHunkSessionContext,
  buildSessionReview: buildHunkSessionReview,
  listComments: listHunkSessionComments,
};

/** How the daemon identifies itself when it reads a resource on an agent's behalf. */
const DAEMON_ACTOR: HunkReviewActorV1 = { clientId: "hunk-daemon", kind: "agent" };

/** Raised when a read or action names a generation the session is no longer serving. */
export class ReviewGenerationRetiredError extends Error {
  override readonly name = "ReviewGenerationRetiredError";

  constructor(readonly currentGeneration: string | undefined) {
    super(
      currentGeneration
        ? `The review generation retired; the session is now serving ${currentGeneration}.`
        : "The review generation retired and the session is no longer connected.",
    );
  }
}

/**
 * Raised when one resource read fails, carrying the code that says how.
 *
 * The code travels with the error because the tiers above this one answer differently for
 * each: a reader retrying an "unknown" resource is the wrong response to corruption, which
 * is why the two are separate codes in the first place
 * (`docs/browser-review-seam-audit.md`, C2/D5).
 */
export class ReviewResourceReadError extends Error {
  override readonly name = "ReviewResourceReadError";

  constructor(
    readonly code: HunkReviewFailureCodeV1,
    message: string,
  ) {
    super(message);
  }
}

/**
 * What one session's review did, as a watcher sees it.
 *
 * Only the two facts a watcher can act on: the session published something new, or it is
 * gone. What changed is deliberately not described — a watcher re-reads the publication
 * rather than being told a delta, so there is no second description of a review to keep in
 * step with the mirror's.
 */
export type ReviewPublicationEvent =
  | { kind: "published"; sessionId: string }
  | { kind: "retired"; sessionId: string };

/** Read the capability verifier out of one raw registration payload. */
function readRegistrationReviewCapabilityDigest(registrationInput: unknown): string | undefined {
  const info = (registrationInput as { info?: HunkSessionInfo } | null | undefined)?.info;
  return isReviewSha256Digest(info?.reviewCapabilityDigest)
    ? info.reviewCapabilityDigest
    : undefined;
}

/** Run one bounded-parallel pass over a work list, in the shared load concurrency. */
async function inBoundedParallel<Item, Result>(
  items: readonly Item[],
  limit: number,
  run: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = Array.from({ length: items.length }) as Result[];
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** The generic broker this state specializes, named once so the overrides stay readable. */
type HunkBrokerBase = SessionBrokerState<
  HunkSessionInfo,
  HunkSessionState,
  HunkSessionServerMessage,
  HunkSessionCommandResult,
  ListedSession,
  SelectedSessionContext,
  SessionReview,
  SessionLiveCommentSummary
>;

/** The transport handle the broker core identifies a connection by; it does not export one. */
type HunkBrokerConnection = Parameters<HunkBrokerBase["registerSession"]>[0];

export class HunkSessionBrokerState extends SessionBrokerState<
  HunkSessionInfo,
  HunkSessionState,
  HunkSessionServerMessage,
  HunkSessionCommandResult,
  ListedSession,
  SelectedSessionContext,
  SessionReview,
  SessionLiveCommentSummary
> {
  private readonly mirror = new ReviewMirror();
  private readonly resources: ReviewResourceCache;
  /** One load per resource; concurrent callers await the same assembly. */
  private readonly loads = new Map<string, Promise<Uint8Array>>();
  /** Capability verifiers by session, as their registrations declared them. */
  private readonly capabilityDigests = new Map<string, string>();
  private readonly publicationWatchers = new Set<(event: ReviewPublicationEvent) => void>();

  constructor(resources = new ReviewResourceCache()) {
    super(hunkSessionBrokerView);
    this.resources = resources;
  }

  override registerSession(
    socket: HunkBrokerConnection,
    registrationInput: unknown,
    snapshotInput: unknown,
    options?: { replaceOwner?: boolean },
  ) {
    const registered = super.registerSession(socket, registrationInput, snapshotInput, options);
    this.reconcileMirroredSessions();
    if (registered !== "registered") {
      return registered;
    }

    const sessionId = (registrationInput as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId === "string") {
      const digest = readRegistrationReviewCapabilityDigest(registrationInput);
      if (digest) {
        this.capabilityDigests.set(sessionId, digest);
      } else {
        this.capabilityDigests.delete(sessionId);
      }
      this.observePublication(
        sessionId,
        readRegistrationReviewCatalog(registrationInput),
        readSnapshotReviewPublication(snapshotInput),
      );
    }
    return registered;
  }

  override updateSnapshot(socket: HunkBrokerConnection, sessionId: string, snapshotInput: unknown) {
    const result = super.updateSnapshot(socket, sessionId, snapshotInput);
    if (result === "updated") {
      // A snapshot carries no catalog, so only a further revision of the generation
      // already mirrored can be adopted from one; a generation change waits for the
      // registration that describes it.
      this.observePublication(
        sessionId,
        this.mirror.get(sessionId)?.catalog,
        readSnapshotReviewPublication(snapshotInput),
      );
    }
    return result;
  }

  override unregisterSocket(socket: HunkBrokerConnection) {
    super.unregisterSocket(socket);
    this.reconcileMirroredSessions();
  }

  override pruneStaleSessions(options: { ttlMs: number; now?: number }) {
    const removed = super.pruneStaleSessions(options);
    if (removed > 0) {
      this.reconcileMirroredSessions();
    }
    return removed;
  }

  override shutdown(error?: Error) {
    const watched = this.mirror.sessionIds();
    super.shutdown(error);
    this.mirror.clear();
    this.resources.clear();
    this.loads.clear();
    this.capabilityDigests.clear();
    for (const sessionId of watched) {
      this.notifyPublicationWatchers({ kind: "retired", sessionId });
    }
    this.publicationWatchers.clear();
  }

  /** What the daemon believes one session is currently publishing. */
  getReviewPublication(sessionId: string): MirroredReviewPublication | undefined {
    return this.mirror.get(sessionId);
  }

  /**
   * The capability verifier one session registered, if it registered one.
   *
   * A digest, so a caller can check a presented capability without the daemon ever being
   * able to produce one.
   */
  getReviewCapabilityDigest(sessionId: string): string | undefined {
    return this.capabilityDigests.get(sessionId);
  }

  /**
   * Watch every session's review publications.
   *
   * The daemon already learns about them while mirroring; a watcher gets the same
   * observations rather than polling for them. Returns the unsubscribe.
   */
  subscribeReviewPublications(watcher: (event: ReviewPublicationEvent) => void): () => void {
    this.publicationWatchers.add(watcher);
    return () => {
      this.publicationWatchers.delete(watcher);
    };
  }

  /** Retained and reserved resource bytes, for lifecycle assertions. */
  getReviewResourceUsage() {
    return {
      cachedBytes: this.resources.getCachedBytes(),
      reservedBytes: this.resources.getReservedBytes(),
      entryCount: this.resources.getEntryCount(),
    };
  }

  /**
   * Export one session's review, reconstructing raw patch text when it is asked for.
   *
   * Patch bodies are not in the registration any more; they are read back from the
   * generation that published them, in bounded parallel and verified against the digest
   * the producer measured. A session from an older build still embeds its patches, and
   * those files are left exactly as they arrived — the resource path fills in what is
   * missing rather than replacing what is there.
   */
  async getSessionReviewWithResources(
    selector: SessionTargetInput,
    options: { includePatch?: boolean; includeNotes?: boolean } = {},
  ): Promise<SessionReview> {
    const review = this.getSessionReview(selector, options);
    const publication = options.includePatch ? this.mirror.get(review.sessionId) : undefined;
    if (!publication) {
      return review;
    }

    const pending = review.files.filter((file) => file.patch === undefined);
    const loaded = await inBoundedParallel(pending, REVIEW_RESOURCE_LOAD_CONCURRENCY, (file) =>
      this.loadFilePatch(review.sessionId, publication, file),
    );
    const patchByFileId = new Map(pending.map((file, index) => [file.id, loaded[index]!]));
    const files = review.files.map((file) =>
      patchByFileId.has(file.id) ? { ...file, patch: patchByFileId.get(file.id)! } : file,
    );
    return {
      ...review,
      files,
      selectedFile: review.selectedFile
        ? (files.find((file) => file.id === review.selectedFile?.id) ?? review.selectedFile)
        : null,
    };
  }

  /**
   * Read one whole resource from the session that published it.
   *
   * Single-flight per resource per generation, so a burst of callers costs one assembly;
   * bounded by a reservation taken before any bytes are requested; and re-checked against
   * the mirror after the assembly settles, so a generation retired mid-read is reported as
   * retired rather than returned as if it were current.
   */
  async loadReviewResource(
    sessionId: string,
    generation: string,
    resourceId: string,
  ): Promise<Uint8Array> {
    const descriptor = this.requireDescriptor(sessionId, generation, resourceId);
    const key = { sessionId, generation, resourceId };
    const cached = this.resources.get(key);
    if (cached) {
      return cached;
    }

    const loadKey = JSON.stringify([sessionId, generation, resourceId]);
    const running = this.loads.get(loadKey);
    if (running) {
      return running;
    }

    const load = this.assembleResource(key, descriptor).finally(() => {
      this.loads.delete(loadKey);
    });
    this.loads.set(loadKey, load);
    return load;
  }

  /**
   * Forward one review action to the producer that owns the session's review state.
   *
   * The daemon checks only that it is talking to the generation the caller addressed;
   * everything semantic — does this file exist, does this gap contain this line, where
   * does the resulting note hang — is the producer's answer through core, because a
   * second opinion here is precisely the duplication this seam exists to prevent (D3).
   */
  async applyReviewAction(
    sessionId: string,
    generation: string,
    action: HunkReviewActionV1,
    options: { actor?: HunkReviewActorV1; expectedStateRevision?: number } = {},
  ): Promise<HunkReviewActionResultV1> {
    this.assertGenerationActive(sessionId, generation);
    return this.dispatchCommand<HunkReviewActionResultV1, "apply_review_action">({
      selector: { sessionId },
      command: "apply_review_action",
      input: {
        sessionId,
        protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
        generation,
        ...(options.expectedStateRevision !== undefined
          ? { expectedStateRevision: options.expectedStateRevision }
          : {}),
        actor: options.actor ?? DAEMON_ACTOR,
        action,
      },
      timeoutMessage: "Timed out waiting for the session to apply the review action.",
    });
  }

  /** Mirror one publication and act on what changed. */
  private observePublication(
    sessionId: string,
    catalog: MirroredReviewPublication["catalog"] | undefined,
    address: ReturnType<typeof readSnapshotReviewPublication>,
  ) {
    const update = this.mirror.observe({ sessionId, catalog, address });
    if (update.kind === "replaced") {
      // Nothing from the retired generation can be asked for again, and an in-flight read
      // of it can only produce bytes nobody wants.
      this.resources.evictGeneration(sessionId, update.previousGeneration);
    }
    if (update.kind !== "ignored") {
      this.notifyPublicationWatchers({ kind: "published", sessionId });
    }
  }

  /** Drop mirrored publications and cached bytes for sessions the core no longer holds. */
  private reconcileMirroredSessions() {
    const live = new Set(this.listSessions().map((session) => session.sessionId));
    for (const sessionId of this.capabilityDigests.keys()) {
      if (!live.has(sessionId)) {
        this.capabilityDigests.delete(sessionId);
      }
    }
    for (const sessionId of this.mirror.sessionIds()) {
      if (!live.has(sessionId)) {
        this.mirror.forget(sessionId);
        this.resources.evictSession(sessionId);
        this.notifyPublicationWatchers({ kind: "retired", sessionId });
      }
    }
  }

  /** Tell every watcher what one session's review just did, isolating their failures. */
  private notifyPublicationWatchers(event: ReviewPublicationEvent) {
    for (const watcher of Array.from(this.publicationWatchers)) {
      try {
        watcher(event);
      } catch {
        // A watcher that throws is a watcher's bug; the daemon keeps mirroring for the
        // rest of them rather than losing a publication over it.
      }
    }
  }

  /** Resolve one descriptor in the generation the caller named, or say why not. */
  private requireDescriptor(sessionId: string, generation: string, resourceId: string) {
    const publication = this.assertGenerationActive(sessionId, generation);
    const descriptor = publication.catalog.resources.find((resource) => resource.id === resourceId);
    if (!descriptor) {
      throw new ReviewResourceReadError(
        "unknown-resource",
        `Review resource ${resourceId} is not part of generation ${generation}.`,
      );
    }
    return descriptor;
  }

  /** Reject any read or action addressed to a generation the session is not serving. */
  private assertGenerationActive(sessionId: string, generation: string) {
    const publication = this.mirror.get(sessionId);
    if (!publication || publication.address.generation !== generation) {
      throw new ReviewGenerationRetiredError(publication?.address.generation);
    }
    return publication;
  }

  /**
   * Assemble one resource from bounded chunks read over the broker connection.
   *
   * The verification is entirely the shared assembler's: this loop's only jobs are asking
   * for the next window, decoding it, and keeping the daemon's budget honest. A descriptor
   * the producer has already measured is assembled against those measurements; one it has
   * not is assembled against what the first chunk declares.
   */
  private async assembleResource(
    key: { sessionId: string; generation: string; resourceId: string },
    descriptor: ReviewResourceDescriptorV1,
  ): Promise<Uint8Array> {
    const measured = isMaterializedReviewResource(descriptor);
    const reservation: ReviewResourceReservation = this.resources.reserve(
      key,
      measured
        ? descriptor.byteLength!
        : Math.min(REVIEW_RESOURCE_CHUNK_BYTES, reviewResourceCeiling(descriptor.kind)),
    );
    try {
      const assembler = new ReviewChunkAssembler({
        resourceId: key.resourceId,
        generation: key.generation,
        digest: nodeReviewDigest,
        maxBytes: reviewResourceCeiling(descriptor.kind),
        ...(measured
          ? { expected: { byteLength: descriptor.byteLength!, digest: descriptor.digest! } }
          : {}),
      });

      for (;;) {
        this.assertGenerationActive(key.sessionId, key.generation);
        const result = await this.readChunk(key, assembler.nextOffset);
        if (!result.ok) {
          throw new ReviewResourceReadError(result.code, result.message);
        }
        const step = assembler.accept({
          chunk: result.chunk,
          bytes: new Uint8Array(Buffer.from(result.chunk.data, "base64")),
        });
        if (!step.ok) {
          throw new ReviewResourceReadError(step.code, step.message);
        }
        // The declared size is only known once a chunk has arrived; hold the reservation
        // to it before the next window is requested.
        this.resources.resize(reservation, assembler.declaredSize ?? reservation.byteLength);
        if (step.done) {
          break;
        }
      }

      const assembled = assembler.finish();
      if (!assembled.ok) {
        throw new ReviewResourceReadError(assembled.code, assembled.message);
      }
      this.assertGenerationActive(key.sessionId, key.generation);
      this.resources.store(key, assembled.bytes);
      return assembled.bytes;
    } finally {
      this.resources.release(reservation);
    }
  }

  /** Ask the session for one window of one resource. */
  private readChunk(
    key: { sessionId: string; generation: string; resourceId: string },
    offset: number,
  ): Promise<HunkReviewResourceReadResultV1> {
    return this.dispatchCommand<HunkReviewResourceReadResultV1, "read_review_resource">({
      selector: { sessionId: key.sessionId },
      command: "read_review_resource",
      input: {
        sessionId: key.sessionId,
        protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
        actor: DAEMON_ACTOR,
        request: {
          generation: key.generation,
          resourceId: key.resourceId,
          offset,
          length: REVIEW_RESOURCE_CHUNK_BYTES,
        },
      },
      timeoutMessage: "Timed out reading a review resource from the session.",
      timeoutMs: 30_000,
    });
  }

  /** Reconstruct one file's patch text from the generation that published it. */
  private async loadFilePatch(
    sessionId: string,
    publication: MirroredReviewPublication,
    file: SessionReviewFile,
  ): Promise<string> {
    const fileKey = publication.catalog.fileKeysByRuntimeId[file.id];
    if (!fileKey) {
      throw new Error(reviewResourceUnavailableMessage(file.path));
    }
    const bytes = await this.loadReviewResource(
      sessionId,
      publication.address.generation,
      reviewResourceId({ kind: "patch", fileKey }),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
}

/** Wire the generic broker core to Hunk's registration, snapshot, and review projections. */
export function createHunkSessionBrokerState(): HunkSessionBrokerState {
  return new HunkSessionBrokerState();
}

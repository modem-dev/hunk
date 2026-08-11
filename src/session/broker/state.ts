import { createHash } from "node:crypto";
import {
  buildHunkSessionReview,
  buildListedHunkSession,
  buildSelectedHunkSessionContext,
  listHunkSessionComments,
} from "./projections";
import type {
  HunkSessionCommandResult,
  HunkSessionInfo,
  HunkSessionRegistration,
  HunkSessionServerMessage,
  HunkSessionSnapshot,
  HunkSessionState,
  ListedSession,
  SelectedSessionContext,
  SessionLiveCommentSummary,
  SessionReview,
} from "../types";
import {
  MAX_REVIEW_SOURCE_RESOURCE_BYTES,
  REVIEW_RESOURCE_CHUNK_BYTES,
  type HunkReviewActionV1,
  type HunkReviewCommandResult,
  type ReviewCommandErrorResult,
  type ReviewResourceReadResult,
} from "../reviewProtocol";
import {
  parseSessionRegistration,
  parseSessionSnapshot,
  reviewNoteMatchesManifestFile,
} from "./wire";
import {
  SessionBrokerState,
  type SessionBrokerViewAdapter,
  type SessionTargetInput,
} from "@hunk/session-broker-core";
import { ReviewResourceCache, type ReviewResourceReservation } from "./reviewResourceCache";
import { projectManifestReviewCompatibility } from "../reviewCompatibility";

const hunkSessionBrokerView: SessionBrokerViewAdapter<
  HunkSessionInfo,
  HunkSessionState,
  ListedSession,
  SelectedSessionContext,
  SessionReview,
  SessionLiveCommentSummary
> = {
  parseRegistration: parseSessionRegistration,
  parseSnapshot: parseSessionSnapshot,
  buildListedSession: buildListedHunkSession,
  buildSelectedContext: buildSelectedHunkSessionContext,
  buildSessionReview: buildHunkSessionReview,
  listComments: listHunkSessionComments,
};

interface HunkDaemonSocket {
  send(data: string): unknown;
}

export class ReviewGenerationConflictError extends Error {
  readonly code = "stale-generation" as const;

  constructor(readonly currentGeneration: string) {
    super(`Review generation retired or became stale; current generation is ${currentGeneration}.`);
  }
}

export type HunkSessionObserverEvent =
  | { type: "registration"; sessionId: string; generation: string }
  | { type: "document-replaced"; sessionId: string; generation: string; previousGeneration: string }
  | { type: "state-revision"; sessionId: string; generation: string; stateRevision: number }
  | { type: "disconnect"; sessionId: string };

/** Add Hunk review resource mirroring and lifecycle observation above the generic broker. */
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
  private readonly registrations = new Map<string, HunkSessionRegistration>();
  private readonly sessionIdBySocket = new Map<HunkDaemonSocket, string>();
  private readonly socketBySessionId = new Map<string, HunkDaemonSocket>();
  private readonly observers = new Set<(event: HunkSessionObserverEvent) => void>();
  private readonly resourceCache: ReviewResourceCache;
  private readonly resourceLoads = new Map<string, Promise<Uint8Array>>();
  private readonly stateRevisions = new Map<string, number>();
  private readonly reviewSnapshots = new Map<string, HunkSessionSnapshot>();

  constructor(
    resourceCache = new ReviewResourceCache(),
    private readonly allocateResourceBytes: (byteLength: number) => Uint8Array = (byteLength) =>
      new Uint8Array(byteLength),
  ) {
    super(hunkSessionBrokerView);
    this.resourceCache = resourceCache;
  }

  /** Observe Hunk-specific document, state, and disconnect lifecycle changes. */
  subscribeReviewEvents(listener: (event: HunkSessionObserverEvent) => void) {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  private emit(event: HunkSessionObserverEvent) {
    for (const observer of Array.from(this.observers)) observer(event);
  }

  /** Allow a same-revision producer refresh to change only terminal renderer metadata. */
  private sameRevisionSnapshotIsSafe(current: HunkSessionSnapshot, next: HunkSessionSnapshot) {
    const { noteMarkupWidth: _currentWidth, ...currentShared } = current.state;
    const { noteMarkupWidth: _nextWidth, ...nextShared } = next.state;
    return JSON.stringify(currentShared) === JSON.stringify(nextShared);
  }

  /** Validate state references against the exact immutable manifest generation. */
  private snapshotMatchesRegistration(
    registration: HunkSessionRegistration,
    snapshot: HunkSessionSnapshot,
  ) {
    if (snapshot.state.documentGeneration !== registration.info.documentGeneration) return false;
    const manifestFiles = registration.info.reviewManifest.files;
    const filesByKey = new Map(manifestFiles.map((file) => [file.key, file]));
    const staticNoteIds = new Set(
      registration.info.reviewManifest.files.flatMap((file) => file.notes.map((note) => note.id)),
    );
    const mutableNotes = snapshot.state.review.notes;
    const compatibility = projectManifestReviewCompatibility(
      registration.info.reviewManifest,
      snapshot.state.review,
    );
    const selection = snapshot.state.review.selection;
    const selectedFile = selection.fileKey === null ? undefined : filesByKey.get(selection.fileKey);
    const selectedHunk = selectedFile?.hunks[selection.hunkIndex];
    if (
      snapshot.state.selectedHunkIndex !== selection.hunkIndex ||
      (selection.fileKey !== null && !selectedFile) ||
      (selectedFile !== undefined &&
        ((selectedFile.hunkCount === 0 && selection.hunkIndex !== 0) ||
          (selectedFile.hunkCount > 0 && !selectedHunk))) ||
      (selection.fileKey === null &&
        (snapshot.state.selectedFileId !== undefined ||
          snapshot.state.selectedFilePath !== undefined ||
          snapshot.state.selectedHunkOldRange !== undefined ||
          snapshot.state.selectedHunkNewRange !== undefined)) ||
      (selectedFile !== undefined &&
        (snapshot.state.selectedFileId !== selectedFile.runtimeId ||
          snapshot.state.selectedFilePath !== selectedFile.path ||
          snapshot.state.selectedHunkIndex !== selection.hunkIndex ||
          JSON.stringify(snapshot.state.selectedHunkOldRange) !==
            JSON.stringify(selectedHunk?.oldRange) ||
          JSON.stringify(snapshot.state.selectedHunkNewRange) !==
            JSON.stringify(selectedHunk?.newRange))) ||
      mutableNotes.some((note) => {
        const file = filesByKey.get(note.fileKey);
        return !file || staticNoteIds.has(note.id) || !reviewNoteMatchesManifestFile(note, file);
      }) ||
      JSON.stringify(snapshot.state.liveComments) !== JSON.stringify(compatibility.liveComments) ||
      snapshot.state.liveCommentCount !== compatibility.liveComments.length ||
      JSON.stringify(snapshot.state.reviewNotes) !== JSON.stringify(compatibility.reviewNotes) ||
      snapshot.state.reviewNoteCount !== compatibility.reviewNotes.length ||
      new Set(mutableNotes.map((note) => note.id)).size !== mutableNotes.length
    )
      return false;
    return true;
  }

  override registerSession(
    socket: HunkDaemonSocket,
    registrationInput: unknown,
    snapshotInput: unknown,
  ) {
    const registration = parseSessionRegistration(registrationInput);
    const snapshot = parseSessionSnapshot(snapshotInput);
    const previousForSocket = this.sessionIdBySocket.get(socket);
    if (!registration || !snapshot || !this.snapshotMatchesRegistration(registration, snapshot)) {
      if (previousForSocket) this.removeReviewMirror(previousForSocket);
      return super.registerSession(socket, null, null);
    }

    const previous = this.registrations.get(registration.sessionId);
    const previousSocket = this.socketBySessionId.get(registration.sessionId);
    if (previous && previous.info.documentGeneration === registration.info.documentGeneration) {
      const currentRevision = this.stateRevisions.get(registration.sessionId);
      const currentSnapshot = this.reviewSnapshots.get(registration.sessionId);
      const sameRevision =
        currentRevision !== undefined && snapshot.state.stateRevision === currentRevision;
      if (
        JSON.stringify(previous.info.reviewManifest) !==
          JSON.stringify(registration.info.reviewManifest) ||
        (currentRevision !== undefined && snapshot.state.stateRevision < currentRevision) ||
        (sameRevision &&
          currentSnapshot &&
          !this.sameRevisionSnapshotIsSafe(currentSnapshot, snapshot))
      ) {
        return false;
      }
    }
    const registered = super.registerSession(socket, registrationInput, snapshotInput);
    if (!registered) return false;
    if (previousSocket && previousSocket !== socket) this.sessionIdBySocket.delete(previousSocket);
    if (previousForSocket && previousForSocket !== registration.sessionId) {
      this.removeReviewMirror(previousForSocket);
    }
    this.registrations.set(registration.sessionId, registration);
    this.stateRevisions.set(registration.sessionId, snapshot.state.stateRevision);
    this.reviewSnapshots.set(registration.sessionId, snapshot);
    this.sessionIdBySocket.set(socket, registration.sessionId);
    this.socketBySessionId.set(registration.sessionId, socket);
    if (previous && previous.info.documentGeneration !== registration.info.documentGeneration) {
      this.rejectPendingCommandsForSession(
        registration.sessionId,
        new Error("Review generation retired while its resource was loading."),
        (command) => command === "read_review_resource",
      );
      this.resourceCache.evictGeneration(registration.sessionId, previous.info.documentGeneration);
      this.emit({
        type: "document-replaced",
        sessionId: registration.sessionId,
        previousGeneration: previous.info.documentGeneration,
        generation: registration.info.documentGeneration,
      });
    } else {
      this.emit({
        type: "registration",
        sessionId: registration.sessionId,
        generation: registration.info.documentGeneration,
      });
    }
    this.emit({
      type: "state-revision",
      sessionId: registration.sessionId,
      generation: snapshot.state.documentGeneration,
      stateRevision: snapshot.state.stateRevision,
    });
    return true;
  }

  override updateSnapshot(socket: HunkDaemonSocket, sessionId: string, snapshotInput: unknown) {
    const registration = this.registrations.get(sessionId);
    if (!registration || !this.ownsSession(socket, sessionId)) {
      return super.updateSnapshot(socket, sessionId, snapshotInput);
    }
    const snapshot = parseSessionSnapshot(snapshotInput);
    const currentRevision = this.stateRevisions.get(sessionId);
    const currentSnapshot = this.reviewSnapshots.get(sessionId);
    const sameRevision =
      currentRevision !== undefined && snapshot?.state.stateRevision === currentRevision;
    if (
      !snapshot ||
      !this.snapshotMatchesRegistration(registration, snapshot) ||
      (currentRevision !== undefined && snapshot.state.stateRevision < currentRevision) ||
      (sameRevision &&
        currentSnapshot &&
        !this.sameRevisionSnapshotIsSafe(currentSnapshot, snapshot))
    ) {
      return "invalid" as const;
    }
    const result = super.updateSnapshot(socket, sessionId, snapshotInput);
    if (result === "updated") {
      this.stateRevisions.set(sessionId, snapshot.state.stateRevision);
      this.reviewSnapshots.set(sessionId, snapshot);
      if (!sameRevision) {
        this.emit({
          type: "state-revision",
          sessionId,
          generation: snapshot.state.documentGeneration,
          stateRevision: snapshot.state.stateRevision,
        });
      }
    }
    return result;
  }

  override unregisterSocket(socket: HunkDaemonSocket) {
    const sessionId = this.sessionIdBySocket.get(socket);
    super.unregisterSocket(socket);
    if (sessionId) this.removeReviewMirror(sessionId);
  }

  override pruneStaleSessions(options: { ttlMs: number; now?: number }) {
    const before = new Set(this.registrations.keys());
    const removed = super.pruneStaleSessions(options);
    const live = new Set(this.listSessions().map((session) => session.sessionId));
    for (const sessionId of before) if (!live.has(sessionId)) this.removeReviewMirror(sessionId);
    return removed;
  }

  override shutdown(error?: Error) {
    super.shutdown(error);
    for (const sessionId of this.registrations.keys()) this.resourceCache.evictSession(sessionId);
    this.registrations.clear();
    this.sessionIdBySocket.clear();
    this.socketBySessionId.clear();
    this.resourceLoads.clear();
    this.stateRevisions.clear();
    this.reviewSnapshots.clear();
  }

  /** Return the exact mirrored manifest and semantic state for one authenticated browser session. */
  getBrowserReviewSnapshot(sessionId: string) {
    const registration = this.registrations.get(sessionId);
    const snapshot = this.reviewSnapshots.get(sessionId);
    if (!registration || !snapshot) throw new Error("The review session is not connected.");
    return {
      generation: registration.info.documentGeneration,
      manifest: registration.info.reviewManifest,
      state: snapshot.state.review,
    };
  }

  /** Return the non-secret capability verifier registered for exactly one live session. */
  getBrowserReviewCapabilityHash(sessionId: string) {
    return this.registrations.get(sessionId)?.info.browserReviewCapabilityHash;
  }

  /** Resolve and verify one generation-addressed browser resource through the shared cache. */
  async getBrowserReviewResource(sessionId: string, generation: string, resourceId: string) {
    const registration = this.registrations.get(sessionId);
    if (!registration) throw new Error("The review session is not connected.");
    if (registration.info.documentGeneration !== generation) {
      throw new ReviewGenerationConflictError(registration.info.documentGeneration);
    }
    const descriptor = registration.info.reviewManifest.resources.find(
      (candidate) => candidate.id === resourceId,
    );
    if (!descriptor) throw new Error("The review resource does not exist.");
    const bytes =
      descriptor.byteLength === undefined || !descriptor.digest
        ? await this.loadMaterializingReviewResource(sessionId, generation, descriptor)
        : await this.loadReviewResource(sessionId, generation, descriptor);
    return { descriptor, bytes };
  }

  /** Proxy one strictly generation-scoped action through the existing producer command. */
  applyBrowserReviewAction(
    sessionId: string,
    generation: string,
    action: HunkReviewActionV1,
    expectedStateRevision?: number,
  ) {
    const registration = this.registrations.get(sessionId);
    if (!registration) throw new Error("The review session is not connected.");
    if (registration.info.documentGeneration !== generation) {
      throw new ReviewGenerationConflictError(registration.info.documentGeneration);
    }
    return this.dispatchCommand<HunkReviewCommandResult, "apply_review_action">({
      selector: { sessionId },
      command: "apply_review_action",
      input: {
        sessionId,
        generation,
        ...(expectedStateRevision !== undefined ? { expectedStateRevision } : {}),
        action,
      },
      timeoutMessage: "Timed out waiting for the session to apply a browser review action.",
    });
  }

  /** Reconstruct opt-in patch bodies lazily from verified producer resource chunks. */
  async getSessionReviewWithResources(
    selector: SessionTargetInput,
    options: { includePatch?: boolean; includeNotes?: boolean } = {},
  ) {
    const review = super.getSessionReview(selector, { ...options, includePatch: false });
    if (!options.includePatch) return review;
    const registration = this.registrations.get(review.sessionId);
    if (!registration) throw new Error("The targeted session is no longer connected.");
    const manifest = registration.info.reviewManifest;
    const patches = new Map<string, string>();
    for (const file of manifest.files) {
      const descriptor = manifest.resources.find(
        (resource) => resource.id === file.patchResourceId,
      );
      if (!descriptor)
        throw new Error(`Review manifest references unknown resource ${file.patchResourceId}.`);
      const bytes = await this.loadReviewResource(
        review.sessionId,
        manifest.generation,
        descriptor,
      );
      patches.set(file.runtimeId, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    if (this.registrations.get(review.sessionId)?.info.documentGeneration !== manifest.generation) {
      throw new Error(`Review generation ${manifest.generation} retired during reconstruction.`);
    }
    const files = review.files.map((file) => ({ ...file, patch: patches.get(file.id) }));
    const selectedFile = review.selectedFile
      ? (files.find((file) => file.id === review.selectedFile?.id) ?? null)
      : null;
    return { ...review, files, selectedFile };
  }

  /** Expose cache occupancy for bounded lifecycle tests. */
  getReviewResourceCacheEntryCount() {
    return this.resourceCache.getEntryCount();
  }

  /** Deduplicate, verify, and cache one producer-materialized source for all browser ranges. */
  private async loadMaterializingReviewResource(
    sessionId: string,
    generation: string,
    descriptor: HunkSessionRegistration["info"]["reviewManifest"]["resources"][number],
  ) {
    this.assertReviewGenerationActive(sessionId, generation);
    const cached = this.resourceCache.get(sessionId, generation, descriptor.id);
    if (cached) return cached;
    const key = JSON.stringify([sessionId, generation, descriptor.id]);
    let active = this.resourceLoads.get(key);
    if (!active) {
      const reservation = this.resourceCache.reserveMaterialization(
        sessionId,
        generation,
        descriptor,
        MAX_REVIEW_SOURCE_RESOURCE_BYTES,
      );
      active = this.fetchMaterializingReviewResource(
        sessionId,
        generation,
        descriptor,
        reservation,
      ).finally(() => {
        this.resourceCache.release(reservation);
        this.resourceLoads.delete(key);
      });
      this.resourceLoads.set(key, active);
    }
    try {
      const bytes = await active;
      this.assertReviewGenerationActive(sessionId, generation);
      return bytes;
    } catch (error) {
      this.assertReviewGenerationActive(sessionId, generation);
      throw error;
    }
  }

  /** Read one lazily materialized source while retaining generation and digest verification. */
  private async fetchMaterializingReviewResource(
    sessionId: string,
    generation: string,
    descriptor: HunkSessionRegistration["info"]["reviewManifest"]["resources"][number],
    reservation: ReviewResourceReservation,
  ) {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let contentSize: number | undefined;
    let contentDigest: string | undefined;
    for (;;) {
      this.assertReviewGenerationActive(sessionId, generation);
      const result = await this.dispatchCommand<
        ReviewResourceReadResult | ReviewCommandErrorResult,
        "read_review_resource"
      >({
        selector: { sessionId },
        command: "read_review_resource",
        input: {
          sessionId,
          generation,
          resourceId: descriptor.id,
          offset,
          length: REVIEW_RESOURCE_CHUNK_BYTES,
        },
        timeoutMessage: "Timed out reading expanded review source.",
        timeoutMs: 30_000,
      });
      if (result.kind === "review-error")
        throw new Error(`${result.error.code}: ${result.error.message}`);
      contentSize ??= result.contentSize;
      contentDigest ??= result.contentDigest;
      if (
        result.generation !== generation ||
        result.id !== descriptor.id ||
        result.resourceId !== descriptor.id ||
        result.offset !== offset ||
        result.contentSize !== contentSize ||
        result.contentDigest !== contentDigest ||
        contentSize > MAX_REVIEW_SOURCE_RESOURCE_BYTES ||
        !/^[a-f\d]{64}$/i.test(contentDigest)
      ) {
        throw new Error(`Review resource ${descriptor.id} returned inconsistent metadata.`);
      }
      if (
        typeof result.data !== "string" ||
        result.data.length > Math.ceil(REVIEW_RESOURCE_CHUNK_BYTES / 3) * 4 + 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.data)
      ) {
        throw new Error(`Review resource ${descriptor.id} returned invalid base64 data.`);
      }
      const chunk = Buffer.from(result.data, "base64");
      if (
        chunk.byteLength !== result.byteLength ||
        chunk.byteLength > REVIEW_RESOURCE_CHUNK_BYTES
      ) {
        throw new Error(`Review resource ${descriptor.id} returned an invalid chunk.`);
      }
      chunks.push(chunk);
      offset += chunk.byteLength;
      if (result.eof) break;
      if (chunk.byteLength === 0 || offset >= contentSize) {
        throw new Error(`Review resource ${descriptor.id} did not make bounded progress.`);
      }
    }
    if (contentSize === undefined || contentDigest === undefined || offset !== contentSize) {
      throw new Error(`Review resource ${descriptor.id} ended inconsistently.`);
    }
    const bytes = new Uint8Array(contentSize);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== contentDigest.toLowerCase()) {
      throw new Error(`Review resource ${descriptor.id} failed digest verification.`);
    }
    this.assertReviewGenerationActive(sessionId, generation);
    const materialized = { ...descriptor, byteLength: contentSize, digest: contentDigest };
    this.resourceCache.complete(reservation, materialized, bytes);
    return bytes;
  }

  private async loadReviewResource(
    sessionId: string,
    generation: string,
    descriptor: HunkSessionRegistration["info"]["reviewManifest"]["resources"][number],
  ) {
    const assertActive = () => this.assertReviewGenerationActive(sessionId, generation);
    assertActive();
    const cached = this.resourceCache.get(sessionId, generation, descriptor.id);
    if (cached) {
      assertActive();
      return cached;
    }
    const key = JSON.stringify([sessionId, generation, descriptor.id]);
    let active = this.resourceLoads.get(key);
    if (!active) {
      active = this.fetchReviewResource(sessionId, generation, descriptor).finally(() => {
        this.resourceLoads.delete(key);
      });
      this.resourceLoads.set(key, active);
    }
    let bytes: Uint8Array;
    try {
      bytes = await active;
    } catch (error) {
      // A replacement rejects in-flight broker commands before their producer result settles.
      // Recheck after that rejection so browser callers still receive the typed generation conflict.
      assertActive();
      throw error;
    }
    assertActive();
    return bytes;
  }

  /** Reject a retired generation consistently across cache, fetch, and final-assembly races. */
  private assertReviewGenerationActive(sessionId: string, generation: string) {
    const currentGeneration = this.registrations.get(sessionId)?.info.documentGeneration;
    if (!currentGeneration) throw new Error("The review session disconnected while loading.");
    if (currentGeneration !== generation) {
      throw new ReviewGenerationConflictError(currentGeneration);
    }
  }

  /** Fetch sequential bounded chunks and reject any producer metadata inconsistency. */
  private async fetchReviewResource(
    sessionId: string,
    generation: string,
    descriptor: HunkSessionRegistration["info"]["reviewManifest"]["resources"][number],
  ) {
    if (descriptor.byteLength === undefined || !descriptor.digest) {
      throw new Error(`Review resource ${descriptor.id} is not materialized.`);
    }
    const reservation = this.resourceCache.reserve(sessionId, generation, descriptor);
    try {
      // Allocation is fallible and must remain inside the reservation cleanup boundary.
      const bytes = this.allocateResourceBytes(descriptor.byteLength);
      if (bytes.byteLength !== descriptor.byteLength) {
        throw new Error("Review resource allocator returned an unexpected byte length.");
      }
      let offset = 0;
      do {
        const result = await this.dispatchCommand<
          ReviewResourceReadResult | ReviewCommandErrorResult,
          "read_review_resource"
        >({
          selector: { sessionId },
          command: "read_review_resource",
          input: {
            sessionId,
            generation,
            resourceId: descriptor.id,
            offset,
            length: REVIEW_RESOURCE_CHUNK_BYTES,
          },
          timeoutMessage: "Timed out reading a review resource from the session.",
          timeoutMs: 30_000,
        });
        if (result.kind === "review-error") {
          if (result.error.code === "stale-generation") {
            this.assertReviewGenerationActive(sessionId, generation);
            throw new ReviewGenerationConflictError(
              result.error.currentGeneration ??
                this.registrations.get(sessionId)?.info.documentGeneration ??
                generation,
            );
          }
          throw new Error(`${result.error.code}: ${result.error.message}`);
        }
        if (
          result.generation !== generation ||
          result.id !== descriptor.id ||
          result.resourceId !== descriptor.id ||
          result.offset !== offset ||
          result.contentSize !== descriptor.byteLength ||
          result.contentDigest !== descriptor.digest
        ) {
          throw new Error(`Review resource ${descriptor.id} returned inconsistent metadata.`);
        }
        if (
          typeof result.data !== "string" ||
          result.data.length > Math.ceil(REVIEW_RESOURCE_CHUNK_BYTES / 3) * 4 + 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.data)
        ) {
          throw new Error(`Review resource ${descriptor.id} returned invalid base64 data.`);
        }
        const chunk = Buffer.from(result.data, "base64");
        if (
          chunk.byteLength !== result.byteLength ||
          result.byteLength > REVIEW_RESOURCE_CHUNK_BYTES ||
          (result.eof && offset + chunk.byteLength !== descriptor.byteLength) ||
          (!result.eof && offset + chunk.byteLength >= descriptor.byteLength)
        ) {
          throw new Error(`Review resource ${descriptor.id} returned an invalid chunk length.`);
        }
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
        if (result.eof) break;
        if (chunk.byteLength === 0 || offset > descriptor.byteLength) {
          throw new Error(`Review resource ${descriptor.id} did not make bounded progress.`);
        }
      } while (offset <= descriptor.byteLength);
      this.assertReviewGenerationActive(sessionId, generation);
      this.resourceCache.complete(reservation, descriptor, bytes);
      return bytes;
    } finally {
      this.resourceCache.release(reservation);
    }
  }

  private removeReviewMirror(sessionId: string) {
    if (!this.registrations.has(sessionId)) return;
    this.registrations.delete(sessionId);
    this.stateRevisions.delete(sessionId);
    this.reviewSnapshots.delete(sessionId);
    const socket = this.socketBySessionId.get(sessionId);
    if (socket) this.sessionIdBySocket.delete(socket);
    this.socketBySessionId.delete(sessionId);
    this.resourceCache.evictSession(sessionId);
    this.emit({ type: "disconnect", sessionId });
  }
}

/** Wire the generic broker core to Hunk's bounded review protocol adapter. */
export function createHunkSessionBrokerState(): HunkSessionBrokerState {
  return new HunkSessionBrokerState();
}

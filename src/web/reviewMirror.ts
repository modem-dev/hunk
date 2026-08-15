/**
 * The browser's copy of one live review, and what it does when the review moves.
 *
 * A publication is a position plus a resource catalog, never a diff — so mirroring one
 * means ordering it, and then reading the document behind it out of the catalog it names.
 * Both halves are where the prototype went wrong: its client required contiguous state
 * revisions the server never promised, and recovered from a missed snapshot with a
 * trailing while-loop racing its own epoch counter
 * (`docs/browser-review-seam-audit.md`, C1/C3).
 *
 * Three rules shape this module:
 *
 * - **Ordering is `classifyReviewPublication` and nothing else.** This mirror has no
 *   comparison of its own, which is what the ordering conformance suite proves rather than
 *   trusts.
 * - **A generation is immutable, so a resync happens exactly on `gap`.** Within one
 *   generation the document cannot change — only the review's position in it — so an
 *   `accepted` publication advances the position and reads nothing. A new generation
 *   replaces everything derived from the old one.
 * - **One load at a time, and the newest wins.** A resync belongs to the attachment and
 *   generation that started it; when a later generation arrives, or the mirror is detached,
 *   the in-flight load is abandoned rather than allowed to finish and overwrite what came
 *   after it.
 *
 * Ordering is only half of what the mirror tracks, and conflating the two halves is what
 * left the first version with no way back from a failure: what publication is *current* is
 * the classifier's answer, and what the document on screen was *read for* is load state
 * (`loadedGeneration`). Read together they say when a publication has to be read again —
 * a new generation, or a generation whose document the mirror does not have — and when a
 * publication is merely news that the link is working, which is how a dropped stream comes
 * back without re-reading a document that was never invalidated.
 *
 * What a publication does *not* carry is worth stating, because it is the question Phase 5
 * was told to answer first: selection, filter, expansion, and notes live in the producer's
 * `ReviewState`, and no resource in the catalog contains them. A read-only mirror is
 * therefore a mirror of the review's *content*; sharing its semantic position needs more
 * on the wire than a publication has, which is Phase 5 PR 2's work.
 */
import { createReconnectScheduler, inBoundedParallel } from "@hunk/session-broker-core";
import {
  classifyReviewPublication,
  type ReviewPublicationAddress,
} from "../core/review/generationOrder";
import { reviewFileContentIdentityOf } from "../core/review/document";
import { REVIEW_RESOURCE_LOAD_CONCURRENCY } from "../core/review/resources";
import type { ReviewDocumentV1, ReviewFileV1 } from "../core/review/types";
import type { HunkReviewPublicationBodyV1 } from "../session/reviewHttpProtocol";
import type { HunkReviewResourceCatalogV1 } from "../session/reviewProtocol";
import {
  reviewClientFailure,
  type ReviewApiClient,
  type ReviewClientFailure,
} from "./reviewApiClient";

/**
 * How soon a dropped stream is retried, and how far apart retries grow.
 *
 * Deliberately short at first — a daemon restarting between two keystrokes should not cost
 * a reviewer four seconds of blank screen — and bounded well below any human's patience.
 * Jitter matters because one daemon restart drops every tab at once.
 */
const RECONNECT_DELAY_MS = 500;
const RECONNECT_FACTOR = 2;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_JITTER = 0.25;

/** What this mirror is doing, in the terms a screen has to say something about. */
export type ReviewMirrorStatus =
  /** Nothing has been asked for yet. */
  | "idle"
  /** Attached, and reading the document one publication describes. */
  | "loading"
  /** Holding a complete document for the publication below. */
  | "ready"
  /** The stream dropped over a document that is still good; a retry is pending. */
  | "reconnecting"
  /** The last attempt failed, and there is no document to show; a retry may be pending. */
  | "failed"
  /** The session ended. Nothing further is coming, and no retry will help. */
  | "disconnected";

export interface ReviewMirrorSnapshot {
  status: ReviewMirrorStatus;
  /** Where the review is, as of the last publication accepted. */
  publication?: ReviewPublicationAddress;
  /** The document behind that publication, once every file has been read and verified. */
  document?: ReviewDocumentV1;
  /** Why the last attempt failed, in the shared vocabulary and wording. */
  failure?: ReviewClientFailure;
}

/**
 * What the mirror needs from a transport: content, and news that the review moved.
 *
 * Named as the two methods rather than as the client class so the ordering rules can be
 * driven without a listener, which is how the conformance harness asks them.
 */
export type ReviewMirrorSource = Pick<ReviewApiClient, "readResource" | "streamEvents">;

export interface ReviewMirrorOptions {
  /** Injected so a test can drive time instead of waiting for it. */
  timers?: Parameters<typeof createReconnectScheduler>[0]["timers"];
}

export class ReviewMirror {
  private snapshot: ReviewMirrorSnapshot = { status: "idle" };
  private readonly listeners = new Set<(snapshot: ReviewMirrorSnapshot) => void>();
  private readonly reconnect: ReturnType<typeof createReconnectScheduler>;
  private streamAbort: AbortController | undefined;
  /**
   * The load in flight, if any, and the token that says it is still the one wanted.
   *
   * This is the whole supersede rule: a load checks that its token is still the pending one
   * before it publishes anything, so a newer load or a `stop` simply makes the older load's
   * result unwanted rather than something to cancel and unwind. A token rather than a
   * generation, because a failed load is retried for the generation it already had.
   */
  private pendingLoad: { token: number; publication: ReviewPublicationAddress } | undefined;
  private loadCount = 0;
  /**
   * The generation the document on screen was read for.
   *
   * Load state, not ordering: it says which publications the mirror can answer without
   * reading anything, and is absent whenever there is no document to answer with.
   */
  private loadedGeneration: string | undefined;
  private stopped = false;

  constructor(
    private readonly client: ReviewMirrorSource,
    options: ReviewMirrorOptions = {},
  ) {
    this.reconnect = createReconnectScheduler({
      delayMs: RECONNECT_DELAY_MS,
      factor: RECONNECT_FACTOR,
      maxDelayMs: RECONNECT_MAX_DELAY_MS,
      jitter: RECONNECT_JITTER,
      onDue: () => void this.connect(),
      ...(options.timers ? { timers: options.timers } : {}),
    });
  }

  /** The current view of the review, safe to render directly. */
  getSnapshot(): ReviewMirrorSnapshot {
    return this.snapshot;
  }

  /** Watch the mirror. The listener is not called for the state it already sees. */
  subscribe(listener: (snapshot: ReviewMirrorSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Attach to the review.
   *
   * Only the event stream is opened: its first frame is always a complete publication, so
   * a separate initial fetch would ask the same question twice and give the two answers a
   * chance to disagree.
   *
   * Attaching again after `stop` is deliberate. A view that mounts twice — React's
   * development double-mount, a route left and returned to — asks the same mirror to start
   * twice, and a mirror that could only be detached would leave the second mount blank. A
   * session that said goodbye is the exception: there is nothing left to attach to.
   */
  start() {
    if (this.streamAbort || this.snapshot.status === "disconnected") {
      return;
    }
    this.stopped = false;
    this.reconnect.reset();
    void this.connect();
  }

  /** Detach: end the stream, abandon any load in flight, and retry nothing until `start`. */
  stop() {
    this.stopped = true;
    // Cancelled rather than stopped: the shared scheduler cannot be restarted and this
    // mirror can, so refusing later retries is this flag's job rather than the timer's.
    this.reconnect.cancel();
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    // A load belongs to the attachment that started it; whatever it returns after this
    // describes a review nobody is watching.
    this.pendingLoad = undefined;
  }

  /** Open one event stream and follow it until it ends. */
  private async connect() {
    if (this.stopped) {
      return;
    }
    const abort = new AbortController();
    this.streamAbort = abort;
    await this.client.streamEvents(
      {
        onPublication: (body) => {
          if (abort.signal.aborted) {
            return;
          }
          // A stream that delivers anything is a working stream; the next failure starts
          // its backoff from the beginning rather than from where the last one left off.
          this.reconnect.reset();
          this.observe(body);
        },
        onDisconnect: () => {
          if (abort.signal.aborted) {
            return;
          }
          this.reconnect.cancel();
          this.publish({ ...this.snapshot, status: "disconnected" });
        },
        onError: (failure) => {
          if (!abort.signal.aborted) {
            this.fail(failure);
          }
        },
      },
      abort.signal,
    );
    if (this.streamAbort !== abort) {
      // Detached, or replaced by a later attachment: this stream ending says nothing about
      // the one that took its place, and scheduling from here would open a second.
      return;
    }
    this.streamAbort = undefined;
    if (!this.stopped && this.snapshot.status !== "disconnected") {
      this.reconnect.schedule();
    }
  }

  /**
   * Take one arriving publication.
   *
   * The first one has nothing to be ordered against, so it is adopted; every later one is
   * classified, and only the classifier decides where it sits. What that verdict means for
   * the *document* is then load state's question: a publication whose generation the mirror
   * has no document for has to be read, whether it advances the position or merely repeats
   * it, and that is the retry after a load that failed.
   */
  private observe(body: HunkReviewPublicationBodyV1) {
    const current = this.snapshot.publication;
    if (!current) {
      void this.load(body);
      return;
    }
    const order = classifyReviewPublication(current, body.publication);
    if (order === "gap") {
      // A later generation: nothing derived from the old one carries over, document first.
      void this.load(body);
      return;
    }
    if (order === "stale" && body.publication.generation !== current.generation) {
      // Behind, replayed from another producer, or an identity that does not parse. Not a
      // position this mirror is on, and not a document it should adopt.
      return;
    }
    const document =
      this.loadedGeneration === body.publication.generation ? this.snapshot.document : undefined;
    if (!document && !this.pendingLoad) {
      void this.load(body);
      return;
    }
    if (document) {
      // The document is the one this generation names, so the publication is a position and
      // proof the link works: a stream that dropped and came back recovers here rather than
      // staying failed, and a replay of a position already held only does that much.
      if (order === "accepted" || this.snapshot.status !== "ready") {
        this.publish({
          status: "ready",
          publication: order === "accepted" ? body.publication : current,
          document,
        });
      }
      return;
    }
    if (order === "accepted") {
      // A load for this generation is already reading; this only moves the position it will
      // publish at when it finishes.
      this.publish({ ...this.snapshot, publication: body.publication });
    }
  }

  /** Read the whole document one publication describes, unless a newer one arrives first. */
  private async load(body: HunkReviewPublicationBodyV1) {
    this.loadCount += 1;
    const token = this.loadCount;
    this.pendingLoad = { token, publication: body.publication };
    this.loadedGeneration = undefined;
    this.publish({ status: "loading", publication: body.publication });

    const files = await this.readDocumentFiles(body.catalog);
    if (this.pendingLoad?.token !== token) {
      // Superseded while it was reading — by a later load, or by a `stop` — so this
      // document describes a review nobody is looking at any more.
      return;
    }
    this.pendingLoad = undefined;
    if (!files.ok) {
      this.fail(files);
      return;
    }
    this.loadedGeneration = body.publication.generation;
    this.publish({
      status: "ready",
      publication: this.furthestPublication(body.publication),
      document: { files: files.value },
    });
  }

  /**
   * The further along of where this load started and where the mirror has moved since.
   *
   * A load takes time, and the review may advance within its generation while it reads. The
   * document is the same either way, so finishing must not carry the position back to where
   * the read began — and which of the two is further along is the shared classifier's
   * answer, not a comparison of this module's own.
   */
  private furthestPublication(loaded: ReviewPublicationAddress): ReviewPublicationAddress {
    const held = this.snapshot.publication;
    return held && classifyReviewPublication(loaded, held) === "accepted" ? held : loaded;
  }

  /**
   * Read every file in one catalog, in review order.
   *
   * Order is the catalog's, which is the review's — the producer lists each file's
   * resources in document order, and document order is sidebar and stream order. Loads run
   * under the shared concurrency bound rather than as one unbounded `Promise.all` (C2).
   */
  private async readDocumentFiles(
    catalog: HunkReviewResourceCatalogV1,
  ): Promise<{ ok: true; value: ReviewFileV1[] } | ReviewClientFailure> {
    const descriptors = catalog.resources.filter(
      (resource): resource is Extract<typeof resource, { kind: "canonical-file" }> =>
        resource.kind === "canonical-file",
    );
    const loaded = await inBoundedParallel(
      descriptors,
      REVIEW_RESOURCE_LOAD_CONCURRENCY,
      (descriptor) => this.readCanonicalFile(descriptor),
    );

    const files: ReviewFileV1[] = [];
    for (const result of loaded) {
      if (!result.ok) {
        return result;
      }
      files.push(result.value);
    }
    return { ok: true, value: files };
  }

  /**
   * Read one canonical file and check that it still describes what it claims to.
   *
   * The bytes are already verified against the digest they were served with; what this
   * adds is that they parse as the file the model expects, which is asked by recomputing
   * the file's own content identity rather than by checking a list of fields this client
   * would then own a copy of (D4).
   */
  private async readCanonicalFile(
    descriptor: HunkReviewResourceCatalogV1["resources"][number],
  ): Promise<{ ok: true; value: ReviewFileV1 } | ReviewClientFailure> {
    const bytes = await this.client.readResource(descriptor);
    if (!bytes.ok) {
      return bytes;
    }
    let file: ReviewFileV1;
    try {
      file = JSON.parse(new TextDecoder().decode(bytes.value)) as ReviewFileV1;
      if (file.key !== descriptor.fileKey) {
        throw new Error(`it describes ${file.key}`);
      }
      if (reviewFileContentIdentityOf(file) !== file.contentIdentity) {
        throw new Error("its content does not hash to the identity it declares");
      }
    } catch (error) {
      return reviewClientFailure("resource-integrity", {
        message: `The review served a file for ${descriptor.fileKey} that could not be read${
          error instanceof Error ? `: ${error.message}` : ""
        }.`,
      });
    }
    return { ok: true, value: file };
  }

  /**
   * Record one failure, keeping whatever document is still on screen.
   *
   * A dropped stream over a document the review never invalidated is a link problem rather
   * than a lost review, so it degrades to `reconnecting` — the diff stays readable while
   * the retry is pending, and the next publication over the new stream restores `ready`.
   * Without a document there is nothing to keep reading, and that is `failed`.
   */
  private fail(failure: ReviewClientFailure) {
    if (this.snapshot.status === "disconnected") {
      return;
    }
    this.publish({
      ...this.snapshot,
      status: this.holdsLoadedDocument() ? "reconnecting" : "failed",
      failure,
    });
  }

  /** Whether the document on screen is the one the current publication's generation names. */
  private holdsLoadedDocument() {
    return (
      this.snapshot.document !== undefined &&
      this.loadedGeneration !== undefined &&
      this.loadedGeneration === this.snapshot.publication?.generation
    );
  }

  /** Move to one snapshot and tell everyone watching. */
  private publish(snapshot: ReviewMirrorSnapshot) {
    this.snapshot = snapshot;
    // A copy, so a listener that unsubscribes while being told does not skip the next one.
    for (const listener of Array.from(this.listeners)) {
      listener(snapshot);
    }
  }
}

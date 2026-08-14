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
 * - **One load at a time, and the newest wins.** A resync belongs to the generation that
 *   started it; when a later generation arrives the in-flight one is abandoned rather than
 *   allowed to finish and overwrite what came after it.
 *
 * What a publication does *not* carry is worth stating, because it is the question Phase 5
 * was told to answer first: selection, filter, expansion, and notes live in the producer's
 * `ReviewState`, and no resource in the catalog contains them. A read-only mirror is
 * therefore a mirror of the review's *content*; sharing its semantic position needs more
 * on the wire than a publication has, which is Phase 5 PR 2's work.
 */
import { createReconnectScheduler } from "@hunk/session-broker-core";
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
  /** The last attempt failed; a retry may be pending. */
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

/** Run one bounded-parallel pass over a list, preserving the order of the results. */
async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  run: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = Array.from({ length: items.length }) as Result[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class ReviewMirror {
  private snapshot: ReviewMirrorSnapshot = { status: "idle" };
  private readonly listeners = new Set<(snapshot: ReviewMirrorSnapshot) => void>();
  private readonly reconnect: ReturnType<typeof createReconnectScheduler>;
  private streamAbort: AbortController | undefined;
  /**
   * The generation a load is being performed for.
   *
   * This is the whole supersede rule: a load checks that it is still the current one
   * before it publishes anything, so a newer generation arriving mid-load simply makes the
   * older load's result unwanted rather than something to cancel and unwind.
   */
  private loadingGeneration: string | undefined;
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
   */
  start() {
    if (this.streamAbort || this.stopped) {
      return;
    }
    void this.connect();
  }

  /** Detach for good. */
  stop() {
    this.stopped = true;
    this.reconnect.stop();
    this.streamAbort?.abort();
    this.streamAbort = undefined;
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
          // A stream that delivers anything is a working stream; the next failure starts
          // its backoff from the beginning rather than from where the last one left off.
          this.reconnect.reset();
          this.observe(body);
        },
        onDisconnect: () => {
          this.reconnect.stop();
          this.publish({ ...this.snapshot, status: "disconnected" });
        },
        onError: (failure) => this.fail(failure),
      },
      abort.signal,
    );
    this.streamAbort = undefined;
    if (!this.stopped && this.snapshot.status !== "disconnected") {
      this.reconnect.schedule();
    }
  }

  /**
   * Take one arriving publication.
   *
   * The first one has nothing to be ordered against, so it is adopted; every later one is
   * classified, and only the classifier decides what happens to it.
   */
  private observe(body: HunkReviewPublicationBodyV1) {
    const current = this.snapshot.publication;
    if (!current) {
      void this.load(body);
      return;
    }
    switch (classifyReviewPublication(current, body.publication)) {
      case "accepted":
        // A later revision of the generation already held: the document behind it cannot
        // have changed, so this is a position and nothing to read.
        this.publish({ ...this.snapshot, publication: body.publication });
        return;
      case "gap":
        void this.load(body);
        return;
      case "stale":
        return;
    }
  }

  /** Read the whole document one publication describes, unless a newer one arrives first. */
  private async load(body: HunkReviewPublicationBodyV1) {
    this.loadingGeneration = body.publication.generation;
    this.publish({ status: "loading", publication: body.publication });

    const files = await this.readDocumentFiles(body.catalog);
    if (this.loadingGeneration !== body.publication.generation || this.stopped) {
      // Superseded while it was reading: a later generation is already being loaded, and
      // this document describes a review nobody is looking at any more.
      return;
    }
    if (!files.ok) {
      this.fail(files);
      return;
    }
    this.publish({
      status: "ready",
      publication: body.publication,
      document: { files: files.value },
    });
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
    const loaded = await mapWithConcurrency(
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

  /** Record one failure, keeping whatever document is still on screen. */
  private fail(failure: ReviewClientFailure) {
    if (this.snapshot.status !== "disconnected") {
      this.publish({ ...this.snapshot, status: "failed", failure });
    }
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

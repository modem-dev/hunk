/**
 * Mirrors one session's shared state into the page: notes, filter, note visibility, the file
 * index, agent marks and reveal requests, and the presentation defaults.
 *
 * Every publication the page sees (the first one, and each on the event stream) is offered
 * here as well as to the file mirror. It carries `sharedStateRevision`, which advances only
 * when the snapshot's content changes, so a selection moving in the terminal never makes the
 * page refetch. The page fetches `GET /state` when the generation changes or the shared
 * revision moves within one, or once for a publication that does not state a revision yet.
 *
 * Bodies are ordered exactly as `reviewSharedState.ts` prescribes: across generations by
 * `classifyReviewPublication` on the body's own address, within one by `sharedStateRevision`.
 * Fetches run through one supersede queue (C3), so a newer request cancels an older one and a
 * slow old answer can never replace a newer snapshot. A refused fetch (`state-too-large`, a
 * daemon that predates the route) leaves the last snapshot in place and is retried when the
 * revision next moves.
 *
 * Owns no semantic state. The page's store adopts notes, filter, and visibility through core
 * actions (`../store/clientReviewStore.ts`); the file mirror asks `forGeneration` for the
 * document-ordered file index before it loads a generation's files.
 */
import { createSupersedeQueue } from "@hunk/session-broker-core/lifecycle";
import { classifyReviewPublication } from "../../core/review/generationOrder";
import type {
  HunkReviewPublicationBodyV1,
  HunkReviewStateBodyV1,
} from "../../session/reviewHttpProtocol";
import type { ReviewSharedStateV1 } from "../../session/reviewSharedState";
import { ReviewApiError, type ReviewApiClient } from "../transport/apiClient";

/** What the page knows about the shared state at one moment. */
export interface ReviewSharedStateSnapshot {
  /** The newest snapshot the page accepted. */
  body?: HunkReviewStateBodyV1;
  /** Why the most recent fetch failed, until a later one succeeds. */
  error?: ReviewApiError;
}

/** Whether one state body supersedes the one already shown. */
export function reviewStateBodySupersedes(
  shown: HunkReviewStateBodyV1 | undefined,
  incoming: HunkReviewStateBodyV1,
) {
  if (!shown) return true;
  if (shown.publication.generation === incoming.publication.generation) {
    return incoming.sharedStateRevision > shown.sharedStateRevision;
  }
  return classifyReviewPublication(shown.publication, incoming.publication) === "gap";
}

/** Whether one publication means the shown snapshot is out of date. */
export function reviewPublicationNeedsState(
  shown: HunkReviewStateBodyV1 | undefined,
  publication: HunkReviewPublicationBodyV1,
) {
  if (!shown) return true;
  if (shown.publication.generation !== publication.publication.generation) {
    return classifyReviewPublication(shown.publication, publication.publication) === "gap";
  }
  return (
    publication.sharedStateRevision !== undefined &&
    publication.sharedStateRevision > shown.sharedStateRevision
  );
}

interface GenerationWaiter {
  generation: string;
  resolve: (state: ReviewSharedStateV1 | undefined) => void;
}

export interface ReviewSharedStateMirrorOptions {
  client: ReviewApiClient;
}

/** The mirror of one session's shared state. */
export class ReviewSharedStateMirror {
  private snapshot: ReviewSharedStateSnapshot = {};
  private readonly fetches = createSupersedeQueue();
  private readonly listeners = new Set<() => void>();
  private waiters: GenerationWaiter[] = [];
  /** The newest publication a fetch is in flight for, so repeats do not refetch. */
  private requested: HunkReviewPublicationBodyV1 | undefined;
  private closed = false;

  constructor(private readonly options: ReviewSharedStateMirrorOptions) {}

  getSnapshot = (): ReviewSharedStateSnapshot => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Take one publication and fetch the shared state if it moved. */
  observe(publication: HunkReviewPublicationBodyV1) {
    if (this.closed || !reviewPublicationNeedsState(this.snapshot.body, publication)) return;
    // A fetch already in flight for this position or a later one answers with the current
    // state anyway; asking again would only supersede it.
    const requested = this.requested;
    if (
      requested &&
      requested.publication.generation === publication.publication.generation &&
      (publication.sharedStateRevision === undefined ||
        (requested.sharedStateRevision ?? -1) >= publication.sharedStateRevision)
    ) {
      return;
    }
    this.requested = publication;
    void this.fetch(publication);
  }

  /**
   * Resolve with the shared state for one generation once it is known, or with nothing when
   * it cannot be: the fetch failed, a later generation arrived first, or the signal aborted.
   */
  forGeneration(generation: string, signal?: AbortSignal) {
    const shown = this.snapshot.body;
    if (shown?.publication.generation === generation) return Promise.resolve(shown.state);
    if (this.closed || signal?.aborted) return Promise.resolve(undefined);
    return new Promise<ReviewSharedStateV1 | undefined>((resolve) => {
      const waiter: GenerationWaiter = { generation, resolve };
      this.waiters.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          resolve(undefined);
        },
        { once: true },
      );
    });
  }

  /** Stop fetching and notifying. */
  close() {
    this.closed = true;
    this.fetches.cancel();
    this.listeners.clear();
    this.settleWaiters(undefined, true);
  }

  private async fetch(publication: HunkReviewPublicationBodyV1) {
    const outcome = await this.fetches
      .run((signal) => this.options.client.state(signal))
      .catch((error: unknown) => ({ status: "failed" as const, error }));
    if (this.requested === publication) this.requested = undefined;
    if (outcome.status === "superseded" || this.closed) return;

    if (outcome.status === "failed") {
      const error =
        outcome.error instanceof ReviewApiError
          ? outcome.error
          : new ReviewApiError("unreadable", "The review's shared state could not be read.");
      this.publish({ ...this.snapshot, error });
      // Whoever waited for this generation proceeds without it.
      this.settleWaiters(publication.publication.generation, false);
      return;
    }

    const body = outcome.value;
    if (reviewStateBodySupersedes(this.snapshot.body, body)) {
      this.publish({ body });
    }
    this.settleWaiters(undefined, false);
  }

  /**
   * Resolve waiters the current snapshot answers, and those for `failedGeneration` (or all,
   * when closing) with nothing.
   */
  private settleWaiters(failedGeneration: string | undefined, all: boolean) {
    const shown = this.snapshot.body;
    this.waiters = this.waiters.filter((waiter) => {
      if (shown?.publication.generation === waiter.generation) {
        waiter.resolve(shown.state);
        return false;
      }
      const passed =
        shown !== undefined &&
        classifyReviewPublication(
          { generation: waiter.generation, stateRevision: Number.MAX_SAFE_INTEGER },
          shown.publication,
        ) === "gap";
      if (all || passed || waiter.generation === failedGeneration) {
        waiter.resolve(undefined);
        return false;
      }
      return true;
    });
  }

  private publish(next: ReviewSharedStateSnapshot) {
    this.snapshot = next;
    if (this.closed) return;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

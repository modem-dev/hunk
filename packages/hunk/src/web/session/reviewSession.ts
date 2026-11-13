/**
 * Starts the page's view of one live review: the API client, the mirror, the local store,
 * and the event stream that keeps the mirror current.
 *
 * Opening the review URL is the only trigger. The page path names the session and the
 * fragment carries the capability; both are read once here. The first publication is read
 * from the publication route so the page starts loading before the stream opens; every
 * later one arrives on the stream, and the mirror orders them all with the same classifier.
 *
 * This module wires the pieces together and owns their lifetime; it decides nothing about
 * ordering, loading, or selection, which belong to the mirror and the store.
 */
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import {
  parseReviewCapabilityFragment,
  parseReviewPagePath,
} from "../../session/reviewHttpProtocol";
import { ReviewApiClient, ReviewApiError, type ReviewFetch } from "../transport/apiClient";
import { openReviewEventStream, type ReviewEventStreamStatus } from "../transport/eventStream";
import { ReviewMirror } from "../mirror/reviewMirror";
import { ClientReviewStore } from "../store/clientReviewStore";

/** Shown when the daemon cannot be reached at all, which no review failure code describes. */
export const REVIEW_UNREACHABLE_MESSAGE =
  "The Hunk session daemon did not answer. Check that the review is still running, then reload.";

/** Shown for a response this build cannot read, which no review failure code describes. */
export const REVIEW_UNREADABLE_MESSAGE = "The Hunk session sent a response this page cannot read.";

/** One sentence for one failure, from the shared catalog wherever the code is a review code. */
export function reviewFailureMessage(error: ReviewApiError | undefined) {
  if (!error || error.code === "unreadable") return REVIEW_UNREADABLE_MESSAGE;
  if (error.code === "network") return REVIEW_UNREACHABLE_MESSAGE;
  return reviewErrorMessage(error.code);
}

/** A tiny observable value, so React can subscribe to the stream's connection state. */
export class ObservableValue<T> {
  private readonly listeners = new Set<() => void>();

  constructor(private value: T) {}

  get = () => this.value;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(value: T) {
    this.value = value;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

/** The page's live review, or why it could not start. */
export type ReviewSessionStart =
  | { ok: true; session: ReviewSession }
  | { ok: false; message: string };

/** One running review session in the page. */
export interface ReviewSession {
  sessionId: string;
  client: ReviewApiClient;
  mirror: ReviewMirror;
  review: ClientReviewStore;
  connection: ObservableValue<ReviewEventStreamStatus>;
  close(): void;
}

export interface StartReviewSessionOptions {
  location: { pathname: string; hash: string };
  fetch?: ReviewFetch;
}

/** Start the review this page was opened for. Never throws for a bad address. */
export function startReviewSession({
  location,
  fetch,
}: StartReviewSessionOptions): ReviewSessionStart {
  const route = parseReviewPagePath(location.pathname);
  const capability = parseReviewCapabilityFragment(location.hash);
  if (route?.kind !== "document" || !capability) {
    return { ok: false, message: reviewErrorMessage("unauthorized") };
  }

  const client = new ReviewApiClient({
    sessionId: route.sessionId,
    capability,
    ...(fetch ? { fetch } : {}),
  });
  const mirror = new ReviewMirror({ client });
  const review = new ClientReviewStore({ client });
  const connection = new ObservableValue<ReviewEventStreamStatus>({ kind: "connecting" });

  // The store adopts each document the mirror publishes, which keeps selection and
  // expansion by file key across reloads.
  let adopted = mirror.getSnapshot().document;
  const stopAdopting = mirror.subscribe(() => {
    const snapshot = mirror.getSnapshot();
    if (snapshot.document !== adopted) {
      adopted = snapshot.document;
      review.adopt(snapshot.document, snapshot.catalog);
    }
  });

  const initial = new AbortController();
  void client
    .publication(initial.signal)
    .then((body) => mirror.observe(body))
    .catch((error: unknown) => {
      // The stream opens with a full publication anyway; a failed first read is only fatal
      // when the stream also refuses, which the connection state reports.
      if (error instanceof ReviewApiError && error.code === "unauthorized") {
        connection.set({ kind: "ended", reason: "refused", code: error.code });
      }
    });

  const stream = openReviewEventStream({
    client,
    onEvent: (event) => {
      if (event.type === "publication") mirror.observe(event.body);
    },
    onStatus: (status) => connection.set(status),
  });

  return {
    ok: true,
    session: {
      sessionId: route.sessionId,
      client,
      mirror,
      review,
      connection,
      close() {
        initial.abort();
        stream.close();
        stopAdopting();
        mirror.close();
        review.close();
      },
    },
  };
}

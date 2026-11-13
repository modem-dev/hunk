/**
 * Starts the page's view of one live review: the API client, the file and shared-state
 * mirrors, the local store, and the event stream that keeps both mirrors current.
 *
 * Opening the review URL is the only trigger. The page path names the session and the
 * fragment carries the capability; both are read once here, and the capability moves out of
 * the address into this tab's storage (`capability.ts`). The first publication is read
 * from the publication route so the page starts loading before the stream opens; every
 * later one arrives on the stream, and the mirror orders them all with the same classifier.
 * Every publication is offered to the shared-state mirror first, so the snapshot fetch is in
 * flight before the file mirror asks it for the generation's file index. The store adopts a
 * shared-state snapshot only once the file mirror shows that snapshot's generation, so notes
 * never hang on a document they were not resolved against.
 *
 * This module wires the pieces together and owns their lifetime; it decides nothing about
 * ordering, loading, or selection, which belong to the mirror and the store.
 */
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import { parseReviewPagePath } from "../../session/reviewHttpProtocol";
import { ReviewActionSender } from "../actions/reviewActions";
import { WebToasts } from "../actions/toasts";
import { NoteComposerStore } from "../notes/composerStore";
import { takeReviewCapability, type CapabilityStorage } from "./capability";
import { ReviewApiClient, ReviewApiError, type ReviewFetch } from "../transport/apiClient";
import { openReviewEventStream, type ReviewEventStreamStatus } from "../transport/eventStream";
import { reviewSharedFileIndexEntry } from "../mirror/fileIndex";
import { ReviewMirror } from "../mirror/reviewMirror";
import { ReviewSharedStateMirror } from "../mirror/sharedStateMirror";
import { ClientReviewStore } from "../store/clientReviewStore";

export {
  REVIEW_UNREACHABLE_MESSAGE,
  REVIEW_UNREADABLE_MESSAGE,
  reviewFailureMessage,
} from "./failureMessages";

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
  shared: ReviewSharedStateMirror;
  review: ClientReviewStore;
  connection: ObservableValue<ReviewEventStreamStatus>;
  /** Sends the page's review actions. */
  actions: ReviewActionSender;
  /** The page's open note composers and their reload-safe drafts. */
  composers: NoteComposerStore;
  /** Outcomes with no nearer place to show. */
  toasts: WebToasts;
  /** This tab's capability, for "Copy review link" only. */
  capability: string;
  close(): void;
}

export interface StartReviewSessionOptions {
  location: { pathname: string; search?: string; hash: string };
  fetch?: ReviewFetch;
  /** This tab's storage for the capability and drafts; `sessionStorage` in the page. */
  storage?: CapabilityStorage;
  history?: Pick<History, "replaceState">;
}

/** Start the review this page was opened for. Never throws for a bad address. */
export function startReviewSession({
  location,
  fetch,
  storage,
  history,
}: StartReviewSessionOptions): ReviewSessionStart {
  const route = parseReviewPagePath(location.pathname);
  const capability =
    route?.kind === "document"
      ? takeReviewCapability({
          sessionId: route.sessionId,
          location,
          ...(storage ? { storage } : {}),
          ...(history ? { history } : {}),
        })
      : undefined;
  if (route?.kind !== "document" || !capability) {
    return { ok: false, message: reviewErrorMessage("unauthorized") };
  }

  const client = new ReviewApiClient({
    sessionId: route.sessionId,
    capability,
    ...(fetch ? { fetch } : {}),
  });
  const shared = new ReviewSharedStateMirror({ client });
  const mirror = new ReviewMirror({
    client,
    // The shared state's file index fixes document order and fills the sidebar before any
    // canonical file loads; without it the mirror falls back to catalog order.
    indexSource: async (catalog, signal) =>
      (await shared.forGeneration(catalog.generation, signal))?.files.map(
        reviewSharedFileIndexEntry,
      ),
  });
  const review = new ClientReviewStore({ client });
  const actions = new ReviewActionSender({ client, mirror });
  const composers = new NoteComposerStore(
    route.sessionId,
    storage as Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined,
  );
  const toasts = new WebToasts();
  const connection = new ObservableValue<ReviewEventStreamStatus>({ kind: "connecting" });

  // The store adopts each document the mirror publishes, which keeps selection and
  // expansion by file key across reloads, then the shared state of that same generation.
  let adopted = mirror.getSnapshot().document;
  const adoptShared = () => {
    const state = shared.getSnapshot().body?.state;
    if (state && state.generation === mirror.getSnapshot().address?.generation) {
      review.adoptShared(state);
    }
  };
  const stopAdopting = mirror.subscribe(() => {
    const snapshot = mirror.getSnapshot();
    if (snapshot.document !== adopted) {
      adopted = snapshot.document;
      review.adopt(snapshot.document, snapshot.catalog);
    }
    adoptShared();
  });
  const stopAdoptingShared = shared.subscribe(adoptShared);
  const observe = (body: Parameters<ReviewMirror["observe"]>[0]) => {
    shared.observe(body);
    mirror.observe(body);
  };

  const initial = new AbortController();
  void client
    .publication(initial.signal)
    .then((body) => observe(body))
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
      if (event.type === "publication") observe(event.body);
    },
    onStatus: (status) => connection.set(status),
  });

  return {
    ok: true,
    session: {
      sessionId: route.sessionId,
      client,
      mirror,
      shared,
      review,
      connection,
      actions,
      composers,
      toasts,
      capability,
      close() {
        initial.abort();
        stream.close();
        stopAdopting();
        stopAdoptingShared();
        mirror.close();
        shared.close();
        review.close();
      },
    },
  };
}

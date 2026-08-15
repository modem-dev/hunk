/**
 * Holds the full source text behind each file, for the collapsed regions a reader opens.
 *
 * Expanding a gap needs the whole file, not the patch, so the page reads one `source`
 * resource per file and keeps it. Three facts shape what that means:
 *
 * - **A read belongs to the generation that asked for it.** The same file key over new
 *   content is different text, so a read that lands after a reload is dropped rather than
 *   stored — otherwise a gap in the new generation draws the old file's lines.
 * - **One read per file.** Source text cannot change within a generation, and every read
 *   re-assembles and re-hashes megabytes on the main thread, so opening a second gap in a
 *   file the page already read asks for nothing.
 * - **A failure is a state, not a silence.** A read that was refused is remembered with the
 *   catalog's own wording so the gap can say what happened, instead of claiming forever
 *   that it is still loading.
 *
 * Presentation state, so it lives with this client: a read-only mirror expands gaps for
 * itself, and when expansion becomes a shared intent the answer arrives with the review
 * instead.
 */
import { reviewExpansionSide } from "../core/review/expansion";
import { reviewResourceId } from "../core/review/resources";
import type { ReviewFileV1 } from "../core/review/types";
import type { ReviewApiClient, ReviewClientFailure } from "./reviewApiClient";

/** What the page knows about one file's source text. */
export interface ReviewSourceEntry {
  status: "loading" | "ready" | "failed";
  /** The file's whole source text, once it has been read. */
  text?: string;
  /** Why the read was refused, in the shared vocabulary and wording. */
  failure?: ReviewClientFailure;
}

/** Every file's source state, keyed the way the review addresses files. */
export type ReviewSourceEntries = Readonly<Record<string, ReviewSourceEntry>>;

/** What the store holds, and the generation every entry in it was read for. */
export interface ReviewSourceSnapshot {
  /** Absent until the page knows which generation it is showing. */
  generation: string | undefined;
  entries: ReviewSourceEntries;
}

/** What this store needs from a transport: one resource read. */
export type ReviewSourceReader = Pick<ReviewApiClient, "readResource">;

export class ReviewSourceStore {
  private snapshot: ReviewSourceSnapshot = { generation: undefined, entries: {} };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly client: ReviewSourceReader) {}

  /**
   * The current source state, safe to render directly.
   *
   * The generation rides with the entries so a caller can tell at render time whether they
   * belong to the review it is drawing — a document arrives one render before any effect
   * clearing this store could run, and stale text under a live file key is wrong lines
   * rather than a missing one.
   */
  getSnapshot(): ReviewSourceSnapshot {
    return this.snapshot;
  }

  /** Watch the store. The listener is not called for the state it already sees. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Point the store at one generation, forgetting what was read for another.
   *
   * Reads already in flight are not cancelled — there is nothing to unwind — but what they
   * return is dropped, because they were asked of a review that has since moved on.
   */
  setGeneration(generation: string | undefined) {
    if (this.snapshot.generation === generation) {
      return;
    }
    this.snapshot = { generation, entries: {} };
    this.notify();
  }

  /**
   * Read one file's source, unless it is already read or already being read.
   *
   * A failed entry is read again, which is the retry policy in full: the reader opening the
   * gap again is the only retry gesture a read-only page has, and nothing retries on its own.
   */
  request(file: ReviewFileV1) {
    const { generation, entries } = this.snapshot;
    if (!generation || file.sourceIdentity === undefined) {
      return;
    }
    if (entries[file.key]?.status === "loading" || entries[file.key]?.status === "ready") {
      return;
    }
    this.put(file.key, { status: "loading" });
    void this.client
      .readResource({
        id: reviewResourceId({
          kind: "source",
          fileKey: file.key,
          side: reviewExpansionSide(file.changeKind),
        }),
        generation,
        kind: "source",
      })
      .then((result) => {
        if (this.snapshot.generation !== generation) {
          return;
        }
        this.put(
          file.key,
          result.ok
            ? { status: "ready", text: new TextDecoder().decode(result.value) }
            : { status: "failed", failure: result },
        );
      });
  }

  /** Record one file's state and tell everyone watching. */
  private put(fileKey: string, entry: ReviewSourceEntry) {
    this.snapshot = {
      ...this.snapshot,
      entries: { ...this.snapshot.entries, [fileKey]: entry },
    };
    this.notify();
  }

  private notify() {
    // A copy, so a listener that unsubscribes while being told does not skip the next one.
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }
}

/**
 * Mirrors one session's published review into the page: where it is, and its files.
 *
 * Publications arrive from the event stream (and once from the publication route at start).
 * Each is ordered only by `classifyReviewPublication` (`docs/browser-review-seam-audit.md`,
 * C1): an accepted one moves the position within the generation; a gap — a reload on the
 * session's side, or the first publication this page sees — starts loading that
 * generation's files; anything stale is ignored. Loads run through one supersede queue
 * (C3), so a newer generation cancels an older one still loading and a slow old load can
 * never overwrite a newer document.
 *
 * Files load as the catalog's `canonical-file` resources, each parsed by the shared validating
 * parser (D4) and verified on the way in by the API client. The page names the files it wants
 * first (`prioritize`): a jump's target still waiting for its file, then the files around the
 * viewport; the rest follow in document order (`fileLoadOrder.ts`). The first generation is
 * published progressively — the document grows as files land, so the page shows partial
 * progress. A wanted file is shown within a frame; the others are batched, because every
 * published document re-renders a stream as long as the review. A later generation replaces
 * the current one only once it has fully loaded, so a reload never flashes a half-empty
 * review.
 *
 * Document order comes from the shared-state file index when the index source supplies one;
 * otherwise the mirror falls back to catalog order, which the producer happens to build by
 * walking the document (`app/review/publication.ts`) but the wire does not guarantee.
 *
 * Owns no semantic state and no React. The client store (`../store/clientReviewStore.ts`)
 * adopts the document this publishes.
 */
import { createSupersedeQueue } from "@hunk/session-broker-core/lifecycle";
import { parseCanonicalReviewFile } from "../../core/review/canonicalFile";
import {
  classifyReviewPublication,
  type ReviewPublicationAddress,
  type ReviewPublicationOrder,
} from "../../core/review/generationOrder";
import type { ReviewResourceDescriptor } from "../../core/review/resources";
import type { ReviewDocument, ReviewFile } from "../../core/review/types";
import type { ReviewPublicationBody } from "../../session/reviewHttpProtocol";
import type { ReviewResourceCatalog } from "../../session/reviewProtocol";
import { ReviewApiError, type ReviewApiClient } from "../transport/apiClient";
import {
  reviewFileIndexEntry,
  type ReviewFileIndexEntry,
  type ReviewFileIndexSource,
} from "./fileIndex";
import {
  CLIENT_REVIEW_LOAD_PRIORITIES,
  ClientFileLoadOrder,
  type ClientReviewLoadPriority,
} from "./fileLoadOrder";

/** One file of the mirrored generation, in document order. */
export interface ClientReviewMirrorFileSlot {
  key: string;
  /** Known as soon as an index source or the canonical file describes it. */
  index?: ReviewFileIndexEntry;
  /** The full file, once loaded and verified. */
  file?: ReviewFile;
}

/** Everything the page knows about the mirrored review at one moment. */
export interface ClientReviewMirrorSnapshot {
  /** `loading` until every file of the shown generation has arrived. */
  status: "waiting" | "loading" | "ready" | "failed";
  /** The publication position of the shown generation. */
  address?: ReviewPublicationAddress;
  catalog?: ReviewResourceCatalog;
  slots: readonly ClientReviewMirrorFileSlot[];
  /** The loaded files in catalog order, as the client store adopts them. */
  document: ReviewDocument;
  loadedFiles: number;
  totalFiles: number;
  /** True while a newer generation loads behind the one shown. */
  updating: boolean;
  /** Why the shown generation, or the one loading, could not be loaded. */
  error?: ReviewApiError;
}

const EMPTY_SNAPSHOT: ClientReviewMirrorSnapshot = {
  status: "waiting",
  slots: [],
  document: { files: [] },
  loadedFiles: 0,
  totalFiles: 0,
  updating: false,
};

export interface ClientReviewMirrorOptions {
  client: ReviewApiClient;
  /** Supplies index entries ahead of canonical files, when a source can. */
  indexSource?: ReviewFileIndexSource;
  /**
   * Coalesces progressive notifications, so a 2,000-file load does not rebuild the document
   * 2,000 times. `frame` is for a file the reader wants and `batch` for the rest; a flush
   * with nothing new to show is a no-op, so a sooner one may overtake a later one.
   */
  scheduleNotify?: (flush: () => void, wait: ClientReviewMirrorNotifyWait) => void;
}

/** How soon a progressive change should reach the page. */
export type ClientReviewMirrorNotifyWait = "frame" | "batch";

/** How long each wait lasts by default, in milliseconds. */
const NOTIFY_WAIT_MS: Record<ClientReviewMirrorNotifyWait, number> = {
  frame: 16,
  // Long enough that background files cost a few renders a second, however many land.
  batch: 250,
};

/** Default batching: a timer per wait. */
function defaultScheduleNotify(flush: () => void, wait: ClientReviewMirrorNotifyWait) {
  setTimeout(flush, NOTIFY_WAIT_MS[wait]);
}

/** Build a snapshot's document from its slots. */
function documentOf(slots: readonly ClientReviewMirrorFileSlot[]): ReviewDocument {
  return { files: slots.flatMap((slot) => (slot.file ? [slot.file] : [])) };
}

/** The mirror of one session's review. */
export class ClientReviewMirror {
  private snapshot: ClientReviewMirrorSnapshot = EMPTY_SNAPSHOT;
  /** Builds the next snapshot once something reads it, so a landing file costs no rebuild. */
  private pending: (() => ClientReviewMirrorSnapshot) | undefined;
  /** The files each priority names; kept across generations, since keys are stable. */
  private readonly priorities: Record<ClientReviewLoadPriority, readonly string[]> = {
    target: [],
    viewport: [],
  };
  /** Whether the stream has said what is near the viewport yet. */
  private viewportKnown = false;
  private observed: ReviewPublicationAddress | undefined;
  /** The generation whose last load failed, so its next delivery loads it again. */
  private failedGeneration: string | undefined;
  private readonly loads = createSupersedeQueue();
  private readonly listeners = new Set<() => void>();
  private readonly scheduledWaits = new Set<ClientReviewMirrorNotifyWait>();
  /** Set while listeners have not heard of the latest snapshot. */
  private unnotified = false;
  private closed = false;

  constructor(private readonly options: ClientReviewMirrorOptions) {}

  getSnapshot = (): ClientReviewMirrorSnapshot => {
    if (this.pending) {
      this.snapshot = this.pending();
      this.pending = undefined;
    }
    return this.snapshot;
  };

  /**
   * Name the files one priority wants loaded first, replacing what it named before: `target`
   * for a jump waiting for its file, `viewport` for the files the stream is about to draw.
   * Reads not started yet follow the new order; files already loaded are unaffected.
   */
  prioritize(priority: ClientReviewLoadPriority, fileKeys: readonly string[]) {
    this.priorities[priority] = fileKeys;
    if (priority === "viewport") this.viewportKnown = true;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Take one arriving publication and act on its verdict.
   *
   * Returns the verdict, so a caller (and the conformance corpus) can see that no ordering
   * rule other than the shared classifier decided it.
   */
  observe(body: ReviewPublicationBody): ReviewPublicationOrder {
    const incoming = body.publication;
    // The first publication is a gap from nothing: there is no generation to continue.
    const verdict = this.observed ? classifyReviewPublication(this.observed, incoming) : "gap";
    if (this.closed) {
      return verdict;
    }
    if (verdict !== "gap" && this.failedGeneration === incoming.generation) {
      // The position was already observed but its files never loaded; a redelivery (a
      // reconnect replays the current publication) is the retry.
      if (verdict === "accepted") this.observed = incoming;
      void this.loadGeneration(body);
      return verdict;
    }
    if (verdict === "stale") {
      return verdict;
    }
    this.observed = incoming;

    if (verdict === "accepted") {
      const shown = this.getSnapshot();
      if (shown.address?.generation === incoming.generation) {
        this.publish({ ...shown, address: incoming });
      }
      return verdict;
    }

    void this.loadGeneration(body);
    return verdict;
  }

  /** Stop loading and notifying. */
  close() {
    this.closed = true;
    this.loads.cancel();
    this.listeners.clear();
  }

  /** Load one generation's files, superseding any load still running. */
  private async loadGeneration(body: ReviewPublicationBody) {
    const { catalog, publication } = body;
    // Only a complete generation on screen is worth holding while a newer one loads. A first
    // load still in flight (or failed) shows no finished document, so the newer generation
    // loads progressively in its place and a failure reaches the `failed` stage.
    const before = this.getSnapshot();
    const replacing = before.address !== undefined && before.status === "ready";
    const canonical = catalog.resources.filter(
      (resource): resource is Extract<ReviewResourceDescriptor, { kind: "canonical-file" }> =>
        resource.kind === "canonical-file",
    );
    // Filled in place as files land; each published snapshot takes a copy.
    let slots: ClientReviewMirrorFileSlot[] = canonical.map((resource) => ({
      key: resource.fileKey,
    }));
    let loaded = 0;
    this.failedGeneration = undefined;

    // A position accepted while the files load is newer than the one the load began at.
    const currentAddress = () =>
      this.observed && this.observed.generation === publication.generation
        ? this.observed
        : publication;
    const stage = (status: ClientReviewMirrorSnapshot["status"], error?: ReviewApiError) => {
      const shownSlots = slots.slice();
      const next: ClientReviewMirrorSnapshot = {
        status,
        address: currentAddress(),
        catalog,
        slots: shownSlots,
        document: documentOf(shownSlots),
        loadedFiles: loaded,
        totalFiles: slots.length,
        updating: false,
        ...(error ? { error } : {}),
      };
      return next;
    };

    if (replacing) {
      this.publish({ ...before, updating: true });
    } else {
      this.publish(stage("loading"));
    }

    const outcome = await this.loads
      .run(async (signal) => {
        const index = await this.options.indexSource?.(catalog, signal);
        if (Array.isArray(index)) {
          // The index states document order; a canonical file it does not list still loads,
          // after the listed ones.
          const listed = new Set(index.map((entry) => entry.key));
          slots = [
            ...index.map((entry) => ({ key: entry.key, index: entry })),
            ...slots.filter((slot) => !listed.has(slot.key)),
          ];
          if (!replacing) this.publishLater(() => stage("loading"), "frame");
        } else if (index) {
          const byKey = index as ReadonlyMap<string, ReviewFileIndexEntry>;
          slots = slots.map((slot) => ({ ...slot, index: byKey.get(slot.key) }));
          if (!replacing) this.publishLater(() => stage("loading"), "frame");
        }
        const positionByKey = new Map(slots.map((slot, position) => [slot.key, position]));
        const order = new ClientFileLoadOrder(
          slots.map((slot) => slot.key),
          new Map(canonical.map((resource, position) => [resource.fileKey, position])),
          () => CLIENT_REVIEW_LOAD_PRIORITIES.map((priority) => this.priorities[priority]),
        );

        await this.options.client.readResources(
          canonical,
          (position, bytes) => {
            const descriptor = canonical[position]!;
            let value: unknown;
            try {
              value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            } catch {
              throw new ReviewApiError(
                "resource-integrity",
                `Canonical file ${descriptor.id} was not JSON.`,
              );
            }
            const parsed = parseCanonicalReviewFile(value, { fileKey: descriptor.fileKey });
            if (!parsed.ok) {
              throw new ReviewApiError(
                "resource-integrity",
                `Canonical file ${descriptor.id} was refused (${parsed.reason}).`,
              );
            }
            const slot = positionByKey.get(descriptor.fileKey) ?? position;
            slots[slot] = {
              key: descriptor.fileKey,
              index: {
                ...reviewFileIndexEntry(parsed.file),
                ...slots[slot]?.index,
                hunkCount: parsed.file.hunks.length,
              },
              file: parsed.file,
            };
            loaded += 1;
            if (!replacing) {
              this.publishLater(
                () => stage("loading"),
                this.wanted(descriptor.fileKey) ? "frame" : "batch",
              );
            }
          },
          signal,
          order,
        );
      })
      .catch((error: unknown) => ({ status: "failed" as const, error }));

    if (outcome.status === "superseded" || this.closed) {
      return;
    }
    if (outcome.status === "failed") {
      const error =
        outcome.error instanceof ReviewApiError
          ? outcome.error
          : new ReviewApiError("unreadable", "The review files could not be loaded.");
      this.failedGeneration = publication.generation;
      // A failed reload keeps showing the generation it was replacing.
      this.publish(
        replacing ? { ...this.getSnapshot(), updating: false, error } : stage("failed", error),
      );
      return;
    }
    this.publish(stage("ready"));
  }

  /**
   * Whether the reader is waiting on one file: a priority names it, or the stream has not
   * said what it shows yet, so the first files are the ones on screen.
   */
  private wanted(fileKey: string) {
    return (
      !this.viewportKnown ||
      CLIENT_REVIEW_LOAD_PRIORITIES.some((priority) => this.priorities[priority].includes(fileKey))
    );
  }

  /** Replace the snapshot and notify at once. */
  private publish(next: ClientReviewMirrorSnapshot) {
    this.pending = undefined;
    this.snapshot = next;
    this.notify();
  }

  /** Replace the snapshot with one built when read, and notify after `wait`. */
  private publishLater(
    build: () => ClientReviewMirrorSnapshot,
    wait: ClientReviewMirrorNotifyWait,
  ) {
    this.pending = build;
    this.unnotified = true;
    // A sooner wait already scheduled covers this change; a later one does not.
    if (this.scheduledWaits.has("frame") || this.scheduledWaits.has(wait)) return;
    this.scheduledWaits.add(wait);
    (this.options.scheduleNotify ?? defaultScheduleNotify)(() => {
      this.scheduledWaits.delete(wait);
      if (this.unnotified) this.notify();
    }, wait);
  }

  private notify() {
    this.unnotified = false;
    if (this.closed) return;
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }
}

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
 * Files load as the catalog's `canonical-file` resources, in catalog order, each parsed by
 * the shared validating parser (D4) and verified on the way in by the API client. The first
 * generation is published progressively — the document grows as files land, so the page
 * shows partial progress. A later generation replaces the current one only once it has
 * fully loaded, so a reload never flashes a half-empty review.
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
import type { ReviewResourceDescriptorV1 } from "../../core/review/resources";
import type { ReviewDocumentV1, ReviewFileV1 } from "../../core/review/types";
import type { HunkReviewPublicationBodyV1 } from "../../session/reviewHttpProtocol";
import type { HunkReviewResourceCatalogV1 } from "../../session/reviewProtocol";
import { ReviewApiError, type ReviewApiClient } from "../transport/apiClient";
import {
  reviewFileIndexEntry,
  type ReviewFileIndexEntry,
  type ReviewFileIndexSource,
} from "./fileIndex";

/** One file of the mirrored generation, in document order. */
export interface ReviewMirrorFileSlot {
  key: string;
  /** Known as soon as an index source or the canonical file describes it. */
  index?: ReviewFileIndexEntry;
  /** The full file, once loaded and verified. */
  file?: ReviewFileV1;
}

/** Everything the page knows about the mirrored review at one moment. */
export interface ReviewMirrorSnapshot {
  /** `loading` until every file of the shown generation has arrived. */
  status: "waiting" | "loading" | "ready" | "failed";
  /** The publication position of the shown generation. */
  address?: ReviewPublicationAddress;
  catalog?: HunkReviewResourceCatalogV1;
  slots: readonly ReviewMirrorFileSlot[];
  /** The loaded files in catalog order, as the client store adopts them. */
  document: ReviewDocumentV1;
  loadedFiles: number;
  totalFiles: number;
  /** True while a newer generation loads behind the one shown. */
  updating: boolean;
  /** Why the shown generation, or the one loading, could not be loaded. */
  error?: ReviewApiError;
}

const EMPTY_SNAPSHOT: ReviewMirrorSnapshot = {
  status: "waiting",
  slots: [],
  document: { files: [] },
  loadedFiles: 0,
  totalFiles: 0,
  updating: false,
};

export interface ReviewMirrorOptions {
  client: ReviewApiClient;
  /** Supplies index entries ahead of canonical files, when a source can. */
  indexSource?: ReviewFileIndexSource;
  /**
   * Coalesces progressive notifications; defaults to one per animation-frame-sized tick so a
   * 2,000-file load does not rebuild the document 2,000 times.
   */
  scheduleNotify?: (flush: () => void) => void;
}

/** Default batching: one notification per ~frame while files stream in. */
function defaultScheduleNotify(flush: () => void) {
  setTimeout(flush, 16);
}

/** Build a snapshot's document from its slots. */
function documentOf(slots: readonly ReviewMirrorFileSlot[]): ReviewDocumentV1 {
  return { files: slots.flatMap((slot) => (slot.file ? [slot.file] : [])) };
}

/** The mirror of one session's review. */
export class ReviewMirror {
  private snapshot: ReviewMirrorSnapshot = EMPTY_SNAPSHOT;
  private observed: ReviewPublicationAddress | undefined;
  /** The generation whose last load failed, so its next delivery loads it again. */
  private failedGeneration: string | undefined;
  private readonly loads = createSupersedeQueue();
  private readonly listeners = new Set<() => void>();
  private notifyScheduled = false;
  private closed = false;

  constructor(private readonly options: ReviewMirrorOptions) {}

  getSnapshot = (): ReviewMirrorSnapshot => this.snapshot;

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
  observe(body: HunkReviewPublicationBodyV1): ReviewPublicationOrder {
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
      if (this.snapshot.address?.generation === incoming.generation) {
        this.publish({ ...this.snapshot, address: incoming }, true);
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
  private async loadGeneration(body: HunkReviewPublicationBodyV1) {
    const { catalog, publication } = body;
    // A first load that failed showed no document, so retrying it loads progressively again.
    const replacing = this.snapshot.address !== undefined && this.snapshot.status !== "failed";
    const canonical = catalog.resources.filter(
      (resource): resource is Extract<ReviewResourceDescriptorV1, { kind: "canonical-file" }> =>
        resource.kind === "canonical-file",
    );
    let slots: ReviewMirrorFileSlot[] = canonical.map((resource) => ({ key: resource.fileKey }));
    let loaded = 0;
    this.failedGeneration = undefined;

    // A position accepted while the files load is newer than the one the load began at.
    const currentAddress = () =>
      this.observed && this.observed.generation === publication.generation
        ? this.observed
        : publication;
    const stage = (status: ReviewMirrorSnapshot["status"], error?: ReviewApiError) => {
      const next: ReviewMirrorSnapshot = {
        status,
        address: currentAddress(),
        catalog,
        slots,
        document: documentOf(slots),
        loadedFiles: loaded,
        totalFiles: slots.length,
        updating: false,
        ...(error ? { error } : {}),
      };
      return next;
    };

    if (replacing) {
      this.publish({ ...this.snapshot, updating: true }, true);
    } else {
      this.publish(stage("loading"), true);
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
          if (!replacing) this.publish(stage("loading"), false);
        } else if (index) {
          const byKey = index as ReadonlyMap<string, ReviewFileIndexEntry>;
          slots = slots.map((slot) => ({ ...slot, index: byKey.get(slot.key) }));
          if (!replacing) this.publish(stage("loading"), false);
        }
        const positionByKey = new Map(slots.map((slot, position) => [slot.key, position]));

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
            slots = slots.slice();
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
            if (!replacing) this.publish(stage("loading"), false);
          },
          signal,
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
        replacing ? { ...this.snapshot, updating: false, error } : stage("failed", error),
        true,
      );
      return;
    }
    this.publish(stage("ready"), true);
  }

  /** Replace the snapshot and notify, at once or coalesced. */
  private publish(next: ReviewMirrorSnapshot, immediate: boolean) {
    this.snapshot = next;
    if (immediate) {
      this.flush();
      return;
    }
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    (this.options.scheduleNotify ?? defaultScheduleNotify)(() => this.flush());
  }

  private flush() {
    this.notifyScheduled = false;
    if (this.closed) return;
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }
}

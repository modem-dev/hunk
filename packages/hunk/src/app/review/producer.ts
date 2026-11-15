/**
 * The review producer: one authority over what a review currently is, and who serves it.
 *
 * The producer owns generations. It publishes one when the review is first loaded and the
 * next one every time the content is reloaded, and everything derived from a generation —
 * the semantic document, its manifest, the descriptors for its resources, the bytes behind
 * them — belongs to that generation and retires with it. Its own ordering is asserted
 * against the shared contract (`core/review/generationOrder.ts`) before anything is
 * published, so a producer bug fails here rather than desynchronizing a reader.
 *
 * It does *not* own the review's live state. `ReviewSessionHost` owns the store; the
 * producer attaches to whichever store the host mounted and plans intents against it, supplying the
 * caller-owned facts core refuses to invent (identity, time, and the annotation index,
 * `ReviewIntentFacts.annotations`) through the same derivation the terminal uses.
 *
 * No transport lives here. Serving the session surface means answering method calls; HTTP,
 * SSE, and a browser client are later phases.
 */
import {
  assertReviewPublicationAdvance,
  formatReviewGeneration,
  nextReviewGeneration,
  type ReviewGenerationIdentity,
  type ReviewPublicationAddress,
} from "../../core/review/generationOrder";
import { buildReviewAnnotationIndex } from "../../core/review/annotations";
import {
  applyReviewIntent,
  type ReviewIntent,
  type ReviewIntentFacts,
  type ReviewIntentOutcomeByType,
} from "../../core/review/intents";
import {
  parseReadReviewResourceRequest,
  REVIEW_RESOURCE_CHUNK_BYTES,
  type ReviewResourceChunkV1,
  type ReviewResourceDescriptorV1,
  type ReviewResourceErrorCode,
  type ReviewRequestErrorCode,
} from "../../core/review/resources";
import type { ReviewDigestFn } from "../../core/review/validation";
import type { ReviewStore } from "../../core/review/store";
import type { DiffFile } from "../../core/changeset/model";
import { nodeReviewDigest } from "../../core/reviewDigest";
import {
  MAX_REVIEW_SHARED_STATE_BYTES,
  parseReviewSharedStateResourceId,
  reviewSharedStateResourceId,
  type ReviewSharedStateV1,
} from "../../session/reviewSharedState";
import { buildReviewPublication, type ReviewPublication } from "./publication";
import { ReviewResourceStore, type ReviewResourceFailure } from "./resourceStore";

/**
 * Everything that can go wrong answering a producer request.
 *
 * Composed from the shared vocabularies rather than restated, so a reader classifies a
 * failure the same way whichever tier reported it.
 */
export type ReviewProducerErrorCode = ReviewResourceErrorCode | ReviewRequestErrorCode;

export interface ReviewProducerFailure {
  ok: false;
  code: ReviewProducerErrorCode;
  message: string;
  /** What the producer is serving now, so a caller can resynchronize without a round trip. */
  currentGeneration: string;
}

export type ReviewProducerChunkResult =
  | { ok: true; chunk: ReviewResourceChunkV1 }
  | ReviewProducerFailure;

export interface ReviewProducerOptions {
  /** Identity of this producer, part of every generation it mints. */
  producerId?: string;
  /** Platform hashing, injected so tests and other runtimes can supply their own. */
  digest?: ReviewDigestFn;
  /** Concurrency limit for bulk resource loads. */
  resourceConcurrency?: number;
  /** The surface that owns the review; defaults to `terminal`. */
  surface?: ReviewProducerSurface;
}

export interface PublishReviewInput {
  files: readonly DiffFile[];
  /** Identity of the review's input as a whole; part of every file key. */
  sourceLabel?: string;
}

/** Fully validated next generation that can be reserved without changing current publication. */
export interface PreparedReviewPublication {
  readonly identity: ReviewGenerationIdentity;
  readonly publication: ReviewPublication;
  readonly resourceStore: ReviewResourceStore;
}

export interface ReviewPublicationCommitOptions {
  detachStore?: boolean;
}

/** One producer-owned reservation whose final commit is synchronous and non-throwing. */
export interface ReservedReviewPublication {
  commit(options?: ReviewPublicationCommitOptions): ReviewPublication;
  cancel(): void;
}

interface PreparedReviewPublicationOwnership {
  producer: ReviewProducer;
  baseGeneration: string;
  state: "prepared" | "reserved" | "settled";
}

const preparedReviewPublicationOwnership = new WeakMap<
  PreparedReviewPublication,
  PreparedReviewPublicationOwnership
>();

/**
 * Where the producer reads one review's shared state from.
 *
 * Supplied with the store by the surface that mounted the review: the host knows when the
 * shared content moved, and the projection needs launch facts (presentation defaults) the
 * producer does not hold.
 */
export interface ReviewSharedStateSource {
  /** Advances exactly when `build` would return different content. */
  getSharedStateRevision(): number;
  /** Project the snapshot for one generation at the current revision. */
  build(generation: string): ReviewSharedStateV1;
  /** Record that an agent asked every surface to show this place (G2). */
  recordAgentReveal?(target: { fileKey: string; hunkIndex: number }): void;
}

/**
 * What kind of surface owns this producer's review.
 *
 * Decides the browser selection policy (G2): a headless session adopts a browser's
 * `selection/anchor` as its focus, a terminal session keeps its own.
 */
export type ReviewProducerSurface = "terminal" | "headless";

/** How many materialized snapshots a producer keeps for readers mid-assembly. */
const SHARED_STATE_MATERIALIZATIONS_KEPT = 4;

/** How many resource ids one bulk request may name at once. */
export const MAX_REVIEW_RESOURCE_BATCH = 512;

export class ReviewProducer {
  /** The surface that owns the review, for actor policy. */
  readonly surface: ReviewProducerSurface;
  private readonly digest: ReviewDigestFn;
  private readonly resourceConcurrency: number | undefined;
  private identity: ReviewGenerationIdentity;
  private publication: ReviewPublication;
  private resourceStore: ReviewResourceStore;
  private store: ReviewStore | undefined;
  private sharedState: ReviewSharedStateSource | undefined;
  /** Materialized snapshots by shared revision, oldest first, for the attached store only. */
  private sharedStateMaterializations = new Map<
    number,
    { bytes: Uint8Array; digest: string; generation: string }
  >();
  /** Generation the attached store was mounted for; unequal means the store is retired. */
  private storeGeneration: string | undefined;
  private publicationReservation: object | undefined;

  constructor(input: PublishReviewInput, options: ReviewProducerOptions = {}) {
    this.digest = options.digest ?? nodeReviewDigest;
    this.surface = options.surface ?? "terminal";
    this.resourceConcurrency = options.resourceConcurrency;
    this.identity = { producerId: options.producerId ?? defaultProducerId(), sequence: 0 };
    this.publication = buildReviewPublication({
      files: input.files,
      generation: formatReviewGeneration(this.identity),
      ...(input.sourceLabel !== undefined ? { sourceLabel: input.sourceLabel } : {}),
    });
    this.resourceStore = this.createResourceStore();
  }

  /** The generation currently being served. */
  getPublication(): ReviewPublication {
    return this.publication;
  }

  /** Where this producer sits in its own sequence, for anyone ordering its publications. */
  getPublicationAddress(): ReviewPublicationAddress {
    return {
      generation: this.publication.generation,
      stateRevision: this.currentStore()?.getSnapshot().stateRevision ?? 0,
    };
  }

  /** Validate and materialize the next generation without changing what this producer serves. */
  preparePublication(input: PublishReviewInput): PreparedReviewPublication {
    const previous = this.getPublicationAddress();
    const identity = nextReviewGeneration(this.identity);
    const generation = formatReviewGeneration(identity);
    // A new generation restarts revisions, so the check is about the generation step; the
    // contract states that revisions are only comparable within one.
    assertReviewPublicationAdvance(previous, { generation, stateRevision: 0 });

    const publication = buildReviewPublication({
      files: input.files,
      generation,
      ...(input.sourceLabel !== undefined ? { sourceLabel: input.sourceLabel } : {}),
    });
    const prepared: PreparedReviewPublication = {
      identity,
      publication,
      resourceStore: this.createResourceStore(publication),
    };
    preparedReviewPublicationOwnership.set(prepared, {
      producer: this,
      baseGeneration: previous.generation,
      state: "prepared",
    });
    return prepared;
  }

  /** Reserve one owned, current preparation before a caller exposes it through a transport. */
  reservePublication(prepared: PreparedReviewPublication): ReservedReviewPublication {
    const ownership = preparedReviewPublicationOwnership.get(prepared);
    if (!ownership || ownership.producer !== this) {
      throw new Error("Cannot reserve a review publication prepared by another producer.");
    }
    if (ownership.state !== "prepared") {
      throw new Error("Cannot reserve a review publication more than once.");
    }
    if (this.publicationReservation) {
      throw new Error("Cannot reserve a review publication while another reservation is active.");
    }
    if (ownership.baseGeneration !== this.publication.generation) {
      throw new Error("Cannot reserve a stale review publication.");
    }

    const reservation = {};
    this.publicationReservation = reservation;
    ownership.state = "reserved";
    let settled = false;

    /** Settle this exact reservation once, optionally publishing its prepared generation. */
    const settle = (
      commit: boolean,
      options: ReviewPublicationCommitOptions = {},
    ): ReviewPublication => {
      if (settled) return this.publication;
      settled = true;
      ownership.state = "settled";
      if (this.publicationReservation !== reservation) return this.publication;
      this.publicationReservation = undefined;
      if (!commit) return this.publication;

      this.identity = prepared.identity;
      this.publication = prepared.publication;
      this.resourceStore = prepared.resourceStore;
      if (options.detachStore) {
        this.store = undefined;
        this.sharedState = undefined;
        this.sharedStateMaterializations.clear();
        this.storeGeneration = undefined;
      }
      return this.publication;
    };

    return {
      commit: (options) => settle(true, options),
      cancel: () => {
        settle(false);
      },
    };
  }

  /**
   * Publish the next generation of this review.
   *
   * The advance is asserted against the shared ordering contract before anything is
   * swapped in, and the previous generation's resources are dropped with it: a reader
   * holding an old generation's descriptor gets `stale-generation` rather than bytes that
   * describe a review nobody is looking at any more.
   */
  publish(input: PublishReviewInput): ReviewPublication {
    const prepared = this.preparePublication(input);
    return this.reservePublication(prepared).commit();
  }

  /**
   * Attach the live review store this producer plans intents against.
   *
   * The host owns the store's lifetime; the producer only needs to be able to reach the
   * current state and commit a plan to it.
   */
  attachStore(store: ReviewStore, sharedState?: ReviewSharedStateSource) {
    this.store = store;
    this.sharedState = sharedState;
    this.sharedStateMaterializations.clear();
    this.storeGeneration = this.publication.generation;
  }

  /**
   * The current shared-state revision, when a host attached a shared-state source.
   *
   * Published beside the position on every snapshot, so the daemon and a browser can tell a
   * selection-only move (no refetch) from a change to notes, filter, or marks.
   */
  getSharedStateRevision(): number | undefined {
    return this.currentStore() ? this.sharedState?.getSharedStateRevision() : undefined;
  }

  /** Record an agent's navigation as the reveal every surface honors, when shared state exists. */
  recordAgentReveal(target: { fileKey: string; hunkIndex: number }) {
    if (this.currentStore()) this.sharedState?.recordAgentReveal?.(target);
  }

  /**
   * The review state this producer plans against, when a host has attached one.
   *
   * Read-only, and the *store's* state rather than a copy: a caller validating a request
   * against the current review — does this file exist, is this the draft I opened — must
   * see exactly what the next intent will be planned against.
   */
  getReviewState() {
    return this.currentStore()?.getSnapshot();
  }

  /**
   * Pair the current generation with the state attached for that generation.
   *
   * Reload commits a new publication with its previous store detached, then the matching
   * host attaches replacement state. Returning nothing during that interval prevents a
   * caller from combining the new generation with state captured from the retired host.
   */
  getPositionedReviewState() {
    const state = this.currentStore()?.getSnapshot();
    return state ? { generation: this.publication.generation, state } : undefined;
  }

  /**
   * Plan and commit one semantic intent on behalf of a caller.
   *
   * The producer supplies the facts core refuses to invent: identity and time, and the
   * annotation index annotated navigation needs. That index is derived from this
   * generation's own diff files through the shared builder, so a move planned here and the
   * same move planned by the terminal walk exactly the same stops.
   */
  applyIntent<T extends ReviewIntent>(
    intent: T,
    facts: ReviewIntentFacts = {},
  ): ReviewIntentOutcomeByType[T["type"]] {
    const store = this.currentStore();
    if (!store) {
      throw new Error("Review producer has no review state attached.");
    }
    return applyReviewIntent(store, intent, { ...this.intentFacts(), ...facts });
  }

  /** Describe every resource this generation offers, measured where it has been produced. */
  describeResources(): ReviewResourceDescriptorV1[] {
    return this.resourceStore.describeAll();
  }

  /**
   * Read one bounded, digest-verified window of one resource.
   *
   * The request is parsed strictly and checked against the current generation before any
   * bytes are produced, so a stale caller is told to resynchronize rather than served
   * content from a review that has moved on.
   */
  async readResource(request: unknown): Promise<ReviewProducerChunkResult> {
    const parsed = parseReadReviewResourceRequest(request);
    if (!parsed) {
      return this.fail(
        "invalid-request",
        `A resource read names a generation, a resource id, a non-negative offset, and a length from 1 to ${REVIEW_RESOURCE_CHUNK_BYTES}.`,
      );
    }
    if (parsed.generation !== this.publication.generation) {
      return this.fail(
        "stale-generation",
        `Review generation ${parsed.generation} is retired; the review is now at ${this.publication.generation}.`,
      );
    }
    const sharedStateRevision = parseReviewSharedStateResourceId(parsed.resourceId);
    if (sharedStateRevision !== undefined) {
      return this.readSharedStateChunk(parsed.resourceId, sharedStateRevision, parsed);
    }

    const read = await this.resourceStore.readChunk(parsed.resourceId, {
      offset: parsed.offset,
      length: parsed.length,
    });
    return read.ok ? read : this.fromResourceFailure(read);
  }

  /**
   * Produce several resources at once, under the store's concurrency limit.
   *
   * The batch is bounded so one caller cannot ask the producer to hold an unbounded number
   * of materialized resources at the same moment; a caller with more to fetch pages.
   */
  async materializeResources(resourceIds: readonly string[]) {
    if (resourceIds.length > MAX_REVIEW_RESOURCE_BATCH) {
      throw new RangeError(
        `A resource batch may name at most ${MAX_REVIEW_RESOURCE_BATCH} resources.`,
      );
    }
    return this.resourceStore.materializeAll(resourceIds);
  }

  /**
   * Serve one window of the shared-state snapshot materialized at one shared revision.
   *
   * The snapshot is serialized once per revision and kept for a few revisions, so a reader
   * assembling it chunk by chunk sees one byte sequence even while the review moves. A revision
   * that is neither current nor kept is `unknown-resource`; the daemon then re-reads the
   * current one. An oversized snapshot is `resource-too-large`, before any bytes are served.
   */
  private readSharedStateChunk(
    requestedId: string,
    requestedRevision: number | "current",
    range: { offset: number; length: number },
  ): ReviewProducerChunkResult {
    const source = this.currentStore() ? this.sharedState : undefined;
    if (!source) {
      return this.fail("unknown-resource", "This review publishes no shared state.");
    }
    // The alias always resolves to the current revision and is answered under its concrete
    // id, so the reader assembles the rest of that one revision.
    const sharedStateRevision =
      requestedRevision === "current" ? source.getSharedStateRevision() : requestedRevision;
    const resourceId =
      requestedRevision === "current"
        ? reviewSharedStateResourceId(sharedStateRevision)
        : requestedId;
    const generation = this.publication.generation;
    let materialized = this.sharedStateMaterializations.get(sharedStateRevision);
    if (!materialized || materialized.generation !== generation) {
      if (sharedStateRevision !== source.getSharedStateRevision()) {
        return this.fail(
          "unknown-resource",
          `Shared state ${sharedStateRevision} is retired; the review is at ${source.getSharedStateRevision()}.`,
        );
      }
      const bytes = new TextEncoder().encode(JSON.stringify(source.build(generation)));
      materialized = { bytes, digest: this.digest(bytes), generation };
      this.sharedStateMaterializations.set(sharedStateRevision, materialized);
      for (const revision of this.sharedStateMaterializations.keys()) {
        if (this.sharedStateMaterializations.size <= SHARED_STATE_MATERIALIZATIONS_KEPT) break;
        this.sharedStateMaterializations.delete(revision);
      }
    }

    const { bytes, digest } = materialized;
    if (bytes.byteLength > MAX_REVIEW_SHARED_STATE_BYTES) {
      return this.fail(
        "resource-too-large",
        `The shared state is ${bytes.byteLength} bytes; at most ${MAX_REVIEW_SHARED_STATE_BYTES} can be served.`,
      );
    }
    if (range.offset > bytes.byteLength) {
      return this.fail(
        "invalid-range",
        `Shared state has ${bytes.byteLength} bytes; offset ${range.offset} is past its end.`,
      );
    }
    const end = Math.min(bytes.byteLength, range.offset + range.length);
    const chunk = bytes.subarray(range.offset, end);
    return {
      ok: true,
      chunk: {
        generation,
        resourceId,
        offset: range.offset,
        byteLength: chunk.byteLength,
        encoding: "base64",
        data: Buffer.from(chunk).toString("base64"),
        contentDigest: digest,
        contentSize: bytes.byteLength,
        eof: end === bytes.byteLength,
      },
    };
  }

  /** Build the resource store that belongs to one prepared or current generation. */
  private createResourceStore(publication = this.publication) {
    return new ReviewResourceStore({
      publication,
      digest: this.digest,
      ...(this.resourceConcurrency !== undefined ? { concurrency: this.resourceConcurrency } : {}),
    });
  }

  /**
   * The caller-owned facts every intent planned here is given.
   *
   * The annotation index is keyed by the file keys of the document the plan will run
   * against — the attached store's, when there is one — rather than by this publication's
   * own. A host that projected its document separately from the producer would otherwise
   * hand the planner an index addressed in a vocabulary the state does not use, and
   * annotated navigation would silently find nothing.
   */
  private intentFacts(): ReviewIntentFacts {
    const document = this.currentStore()?.getSnapshot().document ?? this.publication.document;
    const keyByRuntimeId = new Map(document.files.map((file) => [file.runtimeId, file.key]));
    return {
      annotations: buildReviewAnnotationIndex(
        [...this.publication.diffFilesByKey.values()],
        keyByRuntimeId,
      ),
    };
  }

  /** Return the attached store only while it belongs to the current publication. */
  private currentStore() {
    return this.storeGeneration === this.publication.generation ? this.store : undefined;
  }

  /** Attach the current generation to one failure so a caller can resynchronize. */
  private fail(code: ReviewProducerErrorCode, message: string): ReviewProducerFailure {
    return { ok: false, code, message, currentGeneration: this.publication.generation };
  }

  /** Lift one resource-store failure into the producer's answer, code intact. */
  private fromResourceFailure(failure: ReviewResourceFailure): ReviewProducerFailure {
    return this.fail(failure.code, failure.message);
  }
}

/** A per-process producer identity, unique enough that two Hunks never order together. */
function defaultProducerId() {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 0x10000).toString(36)}`;
}

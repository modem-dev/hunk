/**
 * The daemon's mirror of where each live session's review currently is.
 *
 * A session publishes generations; the daemon has to know which one each session is
 * serving, and which resources that generation offers, in order to broker reads and
 * actions to it. That is the whole of what is mirrored — a position and a catalog. The
 * review itself stays with the session that owns it.
 *
 * The one rule this module implements is *ordering*, and ordering is what
 * `classifyReviewPublication` says, applied verbatim — the mirror has no comparison of its
 * own (`docs/browser-review-seam-audit.md`, C1).
 *
 * A session that publishes nothing, such as one built before the mirror existed, is
 * mirrored as nothing. That is not an error: the daemon still lists it, still brokers its
 * comment commands, and simply has no resources to offer on its behalf.
 */
import {
  classifyReviewPublication,
  type ReviewPublicationAddress,
} from "../../core/review/generationOrder";
import {
  parseHunkReviewPublicationAddress,
  parseHunkReviewResourceCatalog,
  type HunkReviewResourceCatalogV1,
} from "../reviewProtocol";
import type { HunkSessionInfo, HunkSessionState } from "../types";

/** One session's mirrored publication: where it is, and what it offers there. */
export interface MirroredReviewPublication {
  address: ReviewPublicationAddress;
  catalog: HunkReviewResourceCatalogV1;
}

/**
 * What observing one publication did to the mirror.
 *
 * `replaced` carries the generation that was retired, because everything derived from it
 * — cached bytes, in-flight reads — has to be dropped by whoever owns those.
 */
export type ReviewMirrorUpdate =
  | { kind: "adopted"; generation: string }
  | { kind: "advanced"; generation: string; stateRevision: number }
  | { kind: "replaced"; generation: string; previousGeneration: string }
  | { kind: "ignored" };

const IGNORED: ReviewMirrorUpdate = { kind: "ignored" };

export interface ObserveReviewPublicationInput {
  sessionId: string;
  /** The catalog available at this call site: a registration's, or the mirrored one. */
  catalog: HunkReviewResourceCatalogV1 | undefined;
  address: ReviewPublicationAddress | undefined;
}

export class ReviewMirror {
  private readonly publications = new Map<string, MirroredReviewPublication>();

  /** What the daemon currently believes one session is serving. */
  get(sessionId: string): MirroredReviewPublication | undefined {
    return this.publications.get(sessionId);
  }

  /** Every session with a mirrored publication, for lifecycle sweeps. */
  sessionIds(): string[] {
    return [...this.publications.keys()];
  }

  /**
   * Observe one publication a session reported, and order it against what is mirrored.
   *
   * A catalog and an address that name different generations are not a publication: the
   * pair arrives together on registration, and a snapshot that runs ahead of its
   * registration is left for the registration to settle. Holding an address whose catalog
   * is for another generation would mean advertising resources that cannot be read.
   */
  observe({ sessionId, catalog, address }: ObserveReviewPublicationInput): ReviewMirrorUpdate {
    if (!address) {
      return IGNORED;
    }
    const matching = catalog?.generation === address.generation ? catalog : undefined;

    const current = this.publications.get(sessionId);
    if (!current) {
      if (!matching) {
        return IGNORED;
      }
      this.publications.set(sessionId, { address, catalog: matching });
      return { kind: "adopted", generation: address.generation };
    }

    switch (classifyReviewPublication(current.address, address)) {
      case "accepted": {
        this.publications.set(sessionId, { ...current, address });
        return {
          kind: "advanced",
          generation: address.generation,
          stateRevision: address.stateRevision,
        };
      }
      case "gap": {
        // A later generation carries nothing over, so it is only adoptable together with
        // the catalog that describes it.
        if (!matching) {
          return IGNORED;
        }
        const previousGeneration = current.address.generation;
        this.publications.set(sessionId, { address, catalog: matching });
        return { kind: "replaced", generation: address.generation, previousGeneration };
      }
      case "stale":
        return IGNORED;
    }
  }

  /** Forget one session's publication when it disconnects or is pruned. */
  forget(sessionId: string) {
    this.publications.delete(sessionId);
  }

  /** Forget everything, as the daemon shuts down. */
  clear() {
    this.publications.clear();
  }
}

/**
 * Read the review catalog out of one raw registration payload.
 *
 * The mirror observes the same fields the registration parser validated, through the same
 * shared parsers, rather than re-walking a whole registration it has already accepted.
 */
export function readRegistrationReviewCatalog(
  registrationInput: unknown,
): HunkReviewResourceCatalogV1 | undefined {
  const info = (registrationInput as { info?: HunkSessionInfo } | null | undefined)?.info;
  return info?.reviewCatalog === undefined
    ? undefined
    : parseHunkReviewResourceCatalog(info.reviewCatalog);
}

/** Read the publication address out of one raw snapshot payload. */
export function readSnapshotReviewPublication(
  snapshotInput: unknown,
): ReviewPublicationAddress | undefined {
  const state = (snapshotInput as { state?: HunkSessionState } | null | undefined)?.state;
  return state?.reviewPublication === undefined
    ? undefined
    : parseHunkReviewPublicationAddress(state.reviewPublication);
}

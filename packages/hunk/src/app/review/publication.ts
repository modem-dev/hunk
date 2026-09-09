/**
 * One published generation of a review.
 *
 * A publication is what the producer hands to the session layer: the semantic document, a
 * deterministic manifest of it, and a descriptor for every resource the document refers to
 * but does not inline. It is immutable — a reload produces the next publication rather than
 * mutating this one — which is what makes "which generation is this?" answerable rather
 * than a matter of timing.
 *
 * The document itself knows nothing about any of this (`packages/hunk/src/core/review/document.ts`);
 * publication is layered on top so the shared model stays a description of a review rather
 * than of a transport. The vocabulary for addressing and ordering those generations is
 * `packages/hunk/src/core/review/generationOrder.ts`.
 */
import {
  buildReviewContentManifest,
  type ReviewContentManifest,
} from "../../core/review/contentManifest";
import { projectReviewDocument } from "../../core/review/document";
import { reviewExpansionSide } from "../../core/review/expansion";
import {
  REVIEW_CANONICAL_FILE_CONTENT_TYPE,
  REVIEW_PATCH_CONTENT_TYPE,
  REVIEW_SOURCE_CONTENT_TYPE,
  reviewResourceId,
  type ReviewResourceDescriptorV1,
} from "../../core/review/resources";
import type { ReviewDocumentV1, ReviewFileV1 } from "../../core/review/types";
import type { DiffFile } from "../../core/changeset/model";

export interface ReviewPublication {
  /** Serialized generation identity; every descriptor below repeats it. */
  generation: string;
  document: ReviewDocumentV1;
  /** Deterministic snapshot of the document, and the field list resources verify against. */
  manifest: ReviewContentManifest;
  resources: readonly ReviewResourceDescriptorV1[];
  /**
   * The renderer-model files this generation was projected from, in document order.
   *
   * Kept beside the document because materializing a source resource means asking the
   * file's reader for text, and only this object has one. Indexed by file key so a
   * resource read never walks the changeset to find its file.
   */
  readonly diffFilesByKey: ReadonlyMap<string, DiffFile>;
}

/**
 * Every resource one file offers.
 *
 * A canonical form and a patch always exist — both are pure functions of the document, so
 * they are always producible even if nothing ever asks for them. A source resource exists
 * only when the file has expandable source behind it, and only for the side that fills its
 * gaps: offering the other side would advertise a read no gap in this file can use.
 */
function fileResources(file: ReviewFileV1, generation: string): ReviewResourceDescriptorV1[] {
  const base = { generation, fileKey: file.key };
  const resources: ReviewResourceDescriptorV1[] = [
    {
      ...base,
      id: reviewResourceId({ kind: "canonical-file", fileKey: file.key }),
      kind: "canonical-file",
      contentType: REVIEW_CANONICAL_FILE_CONTENT_TYPE,
    },
    {
      ...base,
      id: reviewResourceId({ kind: "patch", fileKey: file.key }),
      kind: "patch",
      contentType: REVIEW_PATCH_CONTENT_TYPE,
    },
  ];

  if (file.sourceIdentity !== undefined) {
    const side = reviewExpansionSide(file.changeKind);
    resources.push({
      ...base,
      id: reviewResourceId({ kind: "source", fileKey: file.key, side }),
      kind: "source",
      contentType: REVIEW_SOURCE_CONTENT_TYPE,
      side,
      sourceIdentity: file.sourceIdentity,
    });
  }
  return resources;
}

export interface BuildReviewPublicationInput {
  files: readonly DiffFile[];
  generation: string;
  /** Identity of the review's input as a whole; part of every file key. */
  sourceLabel?: string;
}

/** Project one changeset into the generation the producer serves. */
export function buildReviewPublication({
  files,
  generation,
  sourceLabel,
}: BuildReviewPublicationInput): ReviewPublication {
  const document = projectReviewDocument(files, sourceLabel ? { sourceLabel } : {});
  return {
    generation,
    document,
    manifest: buildReviewContentManifest(document),
    resources: document.files.flatMap((file) => fileResources(file, generation)),
    diffFilesByKey: new Map(
      document.files.flatMap((file, index) => {
        const diffFile = files[index];
        return diffFile ? [[file.key, diffFile] as const] : [];
      }),
    ),
  };
}

/** Look one file up by the key it is addressed by in this generation. */
export function reviewPublicationFile(publication: ReviewPublication, fileKey: string) {
  return publication.document.files.find((file) => file.key === fileKey);
}

/** Look one resource descriptor up by id within this generation. */
export function reviewPublicationResource(publication: ReviewPublication, resourceId: string) {
  return publication.resources.find((resource) => resource.id === resourceId);
}

import { createHash } from "node:crypto";

export interface SemanticFileIdentityInput {
  sourceIdentity: string;
  path: string;
  previousPath?: string;
}

export interface SemanticFileEntryIdentityInput extends SemanticFileIdentityInput {
  /** Digest of the entry's renderer-neutral diff content. */
  contentIdentity: string;
  /** Occurrence among otherwise indistinguishable entries. */
  duplicateIndex?: number;
}

/** Return a compact deterministic SHA-256 identity for serialization-safe review records. */
export function reviewDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Identify the logical source whose files make up one review document. */
export function reviewDocumentIdentity(sourceIdentity: string) {
  return `review:${reviewDigest(`review-document-v1\0${sourceIdentity}`)}`;
}

/**
 * Identify one file without depending on its position in the review stream.
 *
 * Both rename endpoints participate so reordered files remain identical while a
 * rename cannot collide with an unrelated file already at the destination.
 */
export function semanticFileIdentity({
  sourceIdentity,
  path,
  previousPath,
}: SemanticFileIdentityInput) {
  return `file:${reviewDigest(
    ["review-file-v1", sourceIdentity, previousPath ?? "", path].join("\0"),
  )}`;
}

/**
 * Identify one ordered stream entry while remaining stable when distinct entries reorder.
 *
 * The content identity disambiguates repeated paths in flattened commit streams. Only
 * otherwise indistinguishable duplicates use their occurrence, where no semantic fact
 * exists that could reconcile the copies separately.
 */
export function semanticFileEntryIdentity({
  sourceIdentity,
  path,
  previousPath,
  contentIdentity,
  duplicateIndex = 0,
}: SemanticFileEntryIdentityInput) {
  return `file-entry:${reviewDigest(
    [
      "review-file-entry-v1",
      sourceIdentity,
      previousPath ?? "",
      path,
      contentIdentity,
      String(duplicateIndex),
    ].join("\0"),
  )}`;
}

/** Return source-scoped path keys used to reconcile current and renamed files. */
export function semanticFileMatchKeys({
  sourceIdentity,
  path,
  previousPath,
}: SemanticFileIdentityInput) {
  return [path, previousPath]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => `${sourceIdentity}\0${candidate}`);
}

/** Match files across generations through either endpoint of a rename. */
export function semanticFilesMatch(
  left: SemanticFileIdentityInput,
  right: SemanticFileIdentityInput,
) {
  const rightKeys = new Set(semanticFileMatchKeys(right));
  return semanticFileMatchKeys(left).some((key) => rightKeys.has(key));
}

/** Build a generation-addressed resource id without embedding paths in URLs. */
export function reviewResourceId(
  generation: string,
  fileKey: string,
  kind: "patch" | "source" | "canonical-file",
  side?: "old" | "new",
) {
  return `resource:${reviewDigest([generation, fileKey, kind, side ?? ""].join("\0"))}`;
}

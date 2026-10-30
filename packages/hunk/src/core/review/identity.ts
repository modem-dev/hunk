/**
 * Content-derived identity for reviewed files.
 *
 * A review consumer must be able to ask "is this the same file I was reading?" after a
 * reload, a re-filter, or a transport hop, and answer it without depending on array
 * positions or renderer object identity. Every identity here is a pure function of the
 * facts it names, so two processes projecting the same content agree.
 *
 * The digest is an identity hash, not an integrity check: it is platform-neutral
 * arithmetic rather than a crypto primitive, so the shared model stays importable from a
 * browser bundle without a hashing runtime. Wire-integrity digests belong beside the
 * transport that verifies bytes, not here.
 */

/** Four independent 32-bit FNV-1a lanes, giving a 128-bit identity from one pass. */
const LANE_SEEDS = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b] as const;
const LANE_PRIMES = [0x01000193, 0x01000199, 0x01000187, 0x0100019d] as const;

/** Mix one UTF-16 code unit into every lane. */
function mixLanes(lanes: number[], code: number) {
  for (let lane = 0; lane < lanes.length; lane += 1) {
    lanes[lane] = Math.imul(lanes[lane]! ^ code, LANE_PRIMES[lane]!);
  }
}

/** Render one lane as eight lowercase hex characters. */
function laneHex(value: number) {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/**
 * Hash an ordered sequence of strings into one stable identity.
 *
 * Each part is length-framed, so `["ab", "c"]` and `["a", "bc"]` cannot collide by
 * concatenation — the failure mode a naive join invites when parts are user-controlled
 * paths and file contents.
 */
export function reviewContentDigest(parts: readonly string[]): string {
  const lanes = [...LANE_SEEDS];
  for (const part of parts) {
    for (const code of `${part.length}:`) {
      mixLanes(lanes, code.charCodeAt(0));
    }
    for (let index = 0; index < part.length; index += 1) {
      mixLanes(lanes, part.charCodeAt(index));
    }
    mixLanes(lanes, 0x1f);
  }
  return lanes.map(laneHex).join("");
}

export interface ReviewFileContentIdentityInput {
  path: string;
  previousPath?: string;
  changeKind: string;
  language?: string;
  /** The patch text; some producers omit it for a file they declined to render. */
  patch: string;
  stats: { additions: number; deletions: number; truncated: boolean };
  flags: { untracked: boolean; binary: boolean; tooLarge: boolean; partial: boolean };
  /** Hunk geometry, so a re-parse at a different context width is a different identity. */
  hunkSignature: string;
  /**
   * The rendered lines themselves. Hashed rather than trusted to the patch text, because
   * a producer may hand over parsed lines with no patch at all — and the lines are what a
   * reviewer actually sees.
   */
  additionLines: readonly string[];
  deletionLines: readonly string[];
}

/** Hash every renderer-neutral fact about one file's current content. */
export function reviewFileContentIdentity(input: ReviewFileContentIdentityInput) {
  return reviewContentDigest([
    input.path,
    input.previousPath ?? "",
    input.changeKind,
    input.language ?? "",
    `${input.stats.additions}/${input.stats.deletions}/${input.stats.truncated ? 1 : 0}`,
    `${input.flags.untracked ? 1 : 0}${input.flags.binary ? 1 : 0}${input.flags.tooLarge ? 1 : 0}${input.flags.partial ? 1 : 0}`,
    input.hunkSignature,
    input.patch,
    ...input.additionLines,
    // The two arrays are separated by their own framed marker, so moving a line from one
    // side to the other cannot produce the same sequence.
    "\u0000deletions",
    ...input.deletionLines,
  ]);
}

export interface ReviewFileKeyInput {
  /** Identity of the review's input as a whole, so two changesets never share keys. */
  sourceLabel: string;
  path: string;
  previousPath?: string;
  /** Occurrence counter, used only when one path appears more than once. */
  duplicateIndex: number;
}

/**
 * Build the stable semantic key one reviewed file is addressed by.
 *
 * Deliberately *not* content-derived: a key is the file's address in the review, and a
 * reload that changed the file must still be recognizable as the same file, or every
 * note anchored to it would be orphaned. Whether the content changed is a separate
 * question, answered by `reviewFileContentIdentity`.
 */
export function reviewFileKey(input: ReviewFileKeyInput) {
  return `file:${reviewContentDigest([
    input.sourceLabel,
    input.path,
    input.previousPath ?? "",
    String(input.duplicateIndex),
  ])}`;
}

export interface ReviewSourceIdentityInput {
  path: string;
  contentIdentity: string;
  /** The fetcher's own identity when it has one; absent means "unversioned reader". */
  fetcherCacheKey?: string;
}

/**
 * Identity of the full source text backing one file's expandable gaps.
 *
 * Expansion results and loaded source survive a reload only while this is unchanged. It
 * folds in the file's content identity because a patch that changed means the surrounding
 * source did too, and the fetcher's own cache key because a reader may address a
 * different snapshot of source that the patch alone cannot distinguish.
 */
export function reviewSourceIdentity(input: ReviewSourceIdentityInput) {
  return `source:${reviewContentDigest([
    input.path,
    input.contentIdentity,
    input.fetcherCacheKey ?? "",
  ])}`;
}

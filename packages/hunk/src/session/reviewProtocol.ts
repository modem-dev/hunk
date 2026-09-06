/**
 * The review wire schema: what one review consumer may say to the producer serving it.
 *
 * Everything here is a description of a message, never a decision about a review. The
 * semantics live in `packages/hunk/src/core/review/` and are reached by *deriving* from them rather
 * than restating them:
 *
 * - **The action vocabulary is `ReviewIntent`.** The prototype hand-copied that union
 *   into a wire type, a capability list, and a validator, so an intent added to one was
 *   silently unreachable from the others (`docs/browser-review-seam-audit.md`, B12).
 *   Here the vocabulary *is* `REVIEW_INTENT_TYPES`, and each action's payload is the
 *   intent's own shape plus the few fields only a remote caller needs.
 * - **Validation is the shared validators.** Exact-key checking is `hasExactKeys`; digests
 *   are `isReviewSha256Digest`; note size is core's `reviewNoteWithinSizeLimit`, measured once
 *   over the whole note (D1); the resource read request and chunk are core's own types
 *   (D5). This module declares no digest regex, no second byte measurement, and no copy
 *   of a bound that exists elsewhere.
 * - **Nothing is re-derived.** A caller addressing a line inside an expanded gap sends
 *   the proof it holds (B10); the producer resolves it through `resolveReviewExpandedLine`
 *   and the shared anchor path. The wire never computes hunk intersections or ownership
 *   (D3).
 *
 * The module is browser-safe by construction and gated as such: it imports from
 * `packages/hunk/src/core/review/` and nothing else — no Node builtins, no broker package, no
 * transport. `scripts/source-boundaries.test.ts` enforces that, and the transport-side
 * couplings it deliberately does not import (frame sizes) are asserted against this
 * module's own bounds in `scripts/review-vocabulary.test.ts`.
 */
import type { ReviewExpandedLineClaim } from "../core/review/expansion";
import {
  REVIEW_INTENT_TYPES,
  type ReviewIntent,
  type ReviewIntentPlanningErrorCode,
  type ReviewIntentType,
} from "../core/review/intents";
import { REVIEW_SELECTION_WRAP_POLICY, type ReviewSelectionScope } from "../core/review/navigation";
import { MAX_REVIEW_NOTE_BYTES } from "../core/review/noteSize";
import {
  parseReadReviewResourceRequest,
  parseReviewResourceId,
  REVIEW_CANONICAL_FILE_CONTENT_TYPE,
  REVIEW_PATCH_CONTENT_TYPE,
  REVIEW_SOURCE_CONTENT_TYPE,
  type ReadReviewResourceRequest,
  type ReviewResourceChunkV1,
  type ReviewRequestErrorCode,
  type ReviewResourceDescriptorV1,
  type ReviewResourceErrorCode,
  type ReviewResourceKind,
} from "../core/review/resources";
import {
  parseReviewGeneration,
  type ReviewPublicationAddress,
} from "../core/review/generationOrder";
import type { ReviewRevealAnchor, ReviewRevealRequest } from "../core/review/state";
import type { ReviewLineAddressV1, ReviewSide } from "../core/review/types";
import {
  asRecord,
  hasExactKeys,
  isReviewSha256Digest,
  utf8ByteLength,
} from "../core/review/validation";

export const HUNK_REVIEW_PROTOCOL_VERSION = 1 as const;

/**
 * Largest complete review envelope any transport will carry.
 *
 * The protocol's own bound rather than a repetition of a frame size: a transport that
 * cannot carry this much is the transport's problem to declare, and
 * `scripts/review-vocabulary.test.ts` asserts the session transport's frame limit still
 * accommodates it. Keeping the import out is what lets this module stay browser-safe.
 */
export const MAX_HUNK_REVIEW_ENVELOPE_BYTES = 4 * 1024 * 1024;

/** Largest filter string one action may carry; a filter is a query, not a payload. */
export const MAX_HUNK_REVIEW_FILTER_BYTES = 4 * 1024;

/** Largest identifier (file key, note id, gap id, client id) one action may carry. */
export const MAX_HUNK_REVIEW_IDENTIFIER_BYTES = 1 * 1024;

// -- Actor identity (G2) ----------------------------------------------------------------

/**
 * What kind of surface an actor is.
 *
 * Deliberately coarse. It names where an action came from — a terminal window, a browser
 * tab, an agent's command — and nothing about trust or capability; a client cannot widen
 * what it may do by claiming a kind.
 */
export type HunkReviewActorKindV1 = "terminal" | "browser" | "agent";

export const HUNK_REVIEW_ACTOR_KINDS: readonly HunkReviewActorKindV1[] = [
  "terminal",
  "browser",
  "agent",
];

/**
 * Who performed one action.
 *
 * Carried from the protocol's first version and interpreted by nothing yet, which is the
 * point: with a terminal, a browser, and agents attached to one review, the questions
 * "whose selection is this?" and "who authored this note?" need an answer, and the
 * answer needs a field before it needs a policy (`docs/browser-review-seam-audit.md`,
 * G2). The four parts of that finding split cleanly across phases, and only the first is
 * here: (1) actions carry an actor tag — this type; (2) selection is shared-with-follow
 * or per-client-with-follow — a product decision, Phase 5; (3) note authorship defaults
 * from the actor — Phase 5, where notes are composed remotely; (4) how a client obtains
 * its identity — Phase 4, with the capability the HTTP surface issues.
 *
 * Until then the producer records the tag and applies no policy to it, so adding one
 * later changes behavior rather than the schema.
 */
export interface HunkReviewActorV1 {
  /** Stable within one attached client; opaque to the producer. */
  clientId: string;
  kind: HunkReviewActorKindV1;
  /** Optional human label, e.g. for note authorship once policy exists. */
  displayName?: string;
}

// -- Expanded-line proof (B10) ----------------------------------------------------------

/**
 * A remote caller's evidence that a line it names came from an expanded gap.
 *
 * The same shape core resolves (`ReviewExpandedLineClaim`) rather than a wire-local twin,
 * so there is one description of what the claim is. A line inside a gap is not in the
 * patch, so without this a remote client simply cannot address one — which is what made
 * the prototype's browser structurally weaker than its terminal: clicks inside expanded
 * regions were rejected or mis-sided (B10).
 */
export type HunkReviewExpandedLineProofV1 = ReviewExpandedLineClaim;

// -- Action vocabulary (B12) ------------------------------------------------------------

/**
 * Every action type a review client may send.
 *
 * The intent vocabulary itself, never a list: adding an intent makes it wire-reachable
 * automatically, and a wire-reachable type with no parser in `ACTION_PARSERS` fails to
 * compile. Nothing is withheld, and that is a statement rather than an oversight — a
 * semantic intent resolves at the producer and is broadcast to every attached surface, so
 * every one of them belongs to every surface, while host-only effects (quitting, editing
 * in `$EDITOR`, extension commands) are not intents at all (F4). Withholding one would
 * mean subtracting a named exclusion list here, with the reason it is not shareable.
 */
export const HUNK_REVIEW_ACTION_TYPES: readonly ReviewIntentType[] = REVIEW_INTENT_TYPES;

/**
 * Fields a remote caller needs that a locally planned intent does not.
 *
 * Both are about addressing a line the patch does not contain. A local surface knows
 * which gap it expanded; a remote one has to say so.
 */
interface HunkReviewActionWireFields {
  "notes/start-draft": {
    /** Required when `target` names a line inside an expanded gap. */
    expandedLineProof?: HunkReviewExpandedLineProofV1;
  };
  "notes/create-user": {
    /**
     * The line the caller believes the active draft sits at.
     *
     * A precondition, not a relocation: the producer rejects the save when the draft has
     * moved, so two clients cannot silently save each other's drafts.
     */
    target?: ReviewLineAddressV1;
    expandedLineProof?: HunkReviewExpandedLineProofV1;
  };
}

/** Add each intent's wire-only fields, leaving intents that need none untouched. */
type WithWireFields<Intent extends ReviewIntent> = Intent extends { type: infer Type }
  ? Type extends keyof HunkReviewActionWireFields
    ? Intent & HunkReviewActionWireFields[Type]
    : Intent
  : never;

/** One review action, as a client sends it: the intent plus what a remote caller must state. */
export type HunkReviewActionV1 = WithWireFields<ReviewIntent>;

/** One action, addressed to the exact review position the client believes it is acting on. */
export interface HunkReviewActionEnvelopeV1 {
  protocolVersion: typeof HUNK_REVIEW_PROTOCOL_VERSION;
  generation: string;
  /**
   * The state revision the client had when it decided to act.
   *
   * Optional: a client with no opinion is served last-writer-wins. When present, it is
   * compared through the one ordering contract rather than by a local rule.
   */
  expectedStateRevision?: number;
  actor: HunkReviewActorV1;
  action: HunkReviewActionV1;
}

/** One resource read, addressed the way core states it, with the protocol's own framing. */
export interface HunkReviewResourceReadEnvelopeV1 {
  protocolVersion: typeof HUNK_REVIEW_PROTOCOL_VERSION;
  actor: HunkReviewActorV1;
  request: ReadReviewResourceRequest;
}

/** What a producer answers a resource read with; the chunk is core's own shape. */
export type HunkReviewResourceReadResultV1 =
  | { ok: true; chunk: ReviewResourceChunkV1 }
  | HunkReviewFailureV1;

/** What a producer answers an action with, once it has been applied. */
export interface HunkReviewActionAppliedV1 {
  ok: true;
  generation: string;
  stateRevision: number;
}

/** Everything a producer may answer one action with. */
export type HunkReviewActionResultV1 = HunkReviewActionAppliedV1 | HunkReviewFailureV1;

/**
 * Every way a review command can be refused.
 *
 * Composed from the two vocabularies that already exist — what can go wrong with a
 * resource or a request, and what can go wrong planning an intent — rather than restated
 * as a third. The prototype's wire declared its own overlapping code list, which is how a
 * client ended up classifying the same failure differently depending on which tier
 * reported it (`docs/browser-review-seam-audit.md`, D5).
 */
export type HunkReviewFailureCodeV1 =
  | ReviewResourceErrorCode
  | ReviewRequestErrorCode
  | ReviewIntentPlanningErrorCode;

/** One rejection, in the producer's own vocabulary. */
export interface HunkReviewFailureV1 {
  ok: false;
  code: HunkReviewFailureCodeV1;
  message: string;
  /** What the producer is serving now, so a client can resynchronize without a round trip. */
  currentGeneration: string;
}

/** Everything a producer may answer a review command with. */
export type HunkReviewResultV1 = HunkReviewActionResultV1 | HunkReviewResourceReadResultV1;

// -- Parsing ----------------------------------------------------------------------------

/** Why one wire value was refused, in the two shapes a caller responds to differently. */
export type HunkReviewParseFailure =
  /** The value is not expressible in this protocol version at all. */
  | { ok: false; reason: "invalid" }
  /** The value names an action this producer's vocabulary does not contain. */
  | { ok: false; reason: "unsupported" };

export type HunkReviewParseResult<Value> = { ok: true; value: Value } | HunkReviewParseFailure;

const INVALID: HunkReviewParseFailure = { ok: false, reason: "invalid" };
const UNSUPPORTED: HunkReviewParseFailure = { ok: false, reason: "unsupported" };

/** Whether one value is a non-empty identifier within the shared identifier bound. */
function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8ByteLength(value) <= MAX_HUNK_REVIEW_IDENTIFIER_BYTES
  );
}

/** Whether one value is a non-negative safe integer, as every index and line count is. */
function isIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Whether one value is a 1-based line number. */
function isLineNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSide(value: unknown): value is ReviewSide {
  return value === "old" || value === "new";
}

/** The key list one optional-field shape allows, given which optional fields are present. */
function keysWith(required: readonly string[], optional: Record<string, unknown>) {
  return [...required, ...Object.keys(optional).filter((key) => optional[key] !== undefined)];
}

/** Parse one reveal request; every anchor a renderer implements, and nothing else. */
function parseReveal(value: unknown): ReviewRevealRequest | undefined {
  const record = asRecord(value);
  if (!record || !hasExactKeys(record, ["anchor", "scrollToNote"])) {
    return undefined;
  }
  const anchors: readonly ReviewRevealAnchor[] = ["hunk", "file-top", "none"];
  if (
    !anchors.includes(record.anchor as ReviewRevealAnchor) ||
    typeof record.scrollToNote !== "boolean"
  ) {
    return undefined;
  }
  return record as unknown as ReviewRevealRequest;
}

/** Parse one line address: the side and the 1-based line a caller is pointing at. */
function parseLineAddress(value: unknown): ReviewLineAddressV1 | undefined {
  const record = asRecord(value);
  if (!record || !hasExactKeys(record, ["side", "line"])) {
    return undefined;
  }
  return isSide(record.side) && isLineNumber(record.line)
    ? (record as unknown as ReviewLineAddressV1)
    : undefined;
}

/** Parse one expanded-line proof. Its fields are exactly what core resolves it by. */
export function parseHunkReviewExpandedLineProof(
  value: unknown,
): HunkReviewExpandedLineProofV1 | undefined {
  const record = asRecord(value);
  if (!record || !hasExactKeys(record, ["gapId", "side", "line", "sourceIdentity"])) {
    return undefined;
  }
  return isIdentifier(record.gapId) &&
    isSide(record.side) &&
    isLineNumber(record.line) &&
    isIdentifier(record.sourceIdentity)
    ? (record as unknown as HunkReviewExpandedLineProofV1)
    : undefined;
}

/** Parse one actor tag. Identity is recorded, never trusted for authority. */
export function parseHunkReviewActor(value: unknown): HunkReviewActorV1 | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, keysWith(["clientId", "kind"], { displayName: record.displayName }))
  ) {
    return undefined;
  }
  return isIdentifier(record.clientId) &&
    HUNK_REVIEW_ACTOR_KINDS.includes(record.kind as HunkReviewActorKindV1) &&
    (record.displayName === undefined || isIdentifier(record.displayName))
    ? (record as unknown as HunkReviewActorV1)
    : undefined;
}

/** Every navigable scope, read from the policy table rather than restated (D5). */
const REVIEW_SELECTION_SCOPES = Object.keys(REVIEW_SELECTION_WRAP_POLICY) as ReviewSelectionScope[];

/**
 * One action body parser per action type.
 *
 * Keyed by the derived vocabulary, so an intent that becomes wire-reachable without a
 * parser fails to typecheck rather than silently parsing as `unsupported`.
 */
const ACTION_PARSERS: Record<ReviewIntentType, (record: Record<string, unknown>) => boolean> = {
  "selection/select": (record) =>
    hasExactKeys(record, ["type", "fileKey", "hunkIndex", "reveal"]) &&
    isIdentifier(record.fileKey) &&
    isIndex(record.hunkIndex) &&
    parseReveal(record.reveal) !== undefined,
  "selection/move": (record) =>
    hasExactKeys(record, ["type", "scope", "delta"]) &&
    REVIEW_SELECTION_SCOPES.includes(record.scope as ReviewSelectionScope) &&
    Number.isSafeInteger(record.delta),
  "selection/select-file": (record) =>
    hasExactKeys(record, keysWith(["type", "fileKey"], { reveal: record.reveal })) &&
    isIdentifier(record.fileKey) &&
    (record.reveal === undefined || parseReveal(record.reveal) !== undefined),
  "selection/anchor": (record) =>
    hasExactKeys(record, ["type", "fileKey", "hunkIndex"]) &&
    isIdentifier(record.fileKey) &&
    isIndex(record.hunkIndex),
  "filter/set": (record) =>
    hasExactKeys(record, ["type", "filter"]) &&
    typeof record.filter === "string" &&
    utf8ByteLength(record.filter) <= MAX_HUNK_REVIEW_FILTER_BYTES,
  "notes/set-visibility": (record) =>
    hasExactKeys(record, ["type", "visible"]) && typeof record.visible === "boolean",
  "notes/start-draft": (record) =>
    hasExactKeys(
      record,
      keysWith(["type", "fileKey", "hunkIndex"], {
        target: record.target,
        reveal: record.reveal,
        expandedLineProof: record.expandedLineProof,
      }),
    ) &&
    isIdentifier(record.fileKey) &&
    isIndex(record.hunkIndex) &&
    (record.target === undefined || parseLineAddress(record.target) !== undefined) &&
    (record.reveal === undefined || parseReveal(record.reveal) !== undefined) &&
    (record.expandedLineProof === undefined ||
      parseHunkReviewExpandedLineProof(record.expandedLineProof) !== undefined) &&
    // A proof is evidence about a line, so it is meaningless without one to be about.
    (record.expandedLineProof === undefined || record.target !== undefined),
  "notes/start-edit": (record) =>
    hasExactKeys(record, keysWith(["type", "noteId"], { reveal: record.reveal })) &&
    isIdentifier(record.noteId) &&
    (record.reveal === undefined || parseReveal(record.reveal) !== undefined),
  "notes/start-reply": (record) =>
    hasExactKeys(record, keysWith(["type", "noteId"], { reveal: record.reveal })) &&
    isIdentifier(record.noteId) &&
    (record.reveal === undefined || parseReveal(record.reveal) !== undefined),
  "notes/update-draft": (record) =>
    hasExactKeys(record, ["type", "body"]) &&
    typeof record.body === "string" &&
    utf8ByteLength(record.body) <= MAX_REVIEW_NOTE_BYTES,
  "notes/cancel-draft": (record) => hasExactKeys(record, ["type"]),
  "notes/create-user": (record) =>
    hasExactKeys(
      record,
      keysWith(["type", "consumeDraft"], {
        target: record.target,
        expandedLineProof: record.expandedLineProof,
      }),
    ) &&
    record.consumeDraft === true &&
    (record.target === undefined || parseLineAddress(record.target) !== undefined) &&
    (record.expandedLineProof === undefined ||
      parseHunkReviewExpandedLineProof(record.expandedLineProof) !== undefined) &&
    (record.expandedLineProof === undefined || record.target !== undefined),
  "notes/update-user": (record) =>
    hasExactKeys(record, ["type", "noteId", "consumeDraft"]) &&
    isIdentifier(record.noteId) &&
    record.consumeDraft === true,
  "notes/remove-user": (record) =>
    hasExactKeys(record, ["type", "noteId"]) && isIdentifier(record.noteId),
  "notes/remove-live": (record) =>
    hasExactKeys(record, ["type", "noteId"]) && isIdentifier(record.noteId),
  "notes/clear": (record) =>
    hasExactKeys(
      record,
      keysWith(["type"], { fileKey: record.fileKey, includeUser: record.includeUser }),
    ) &&
    (record.fileKey === undefined || isIdentifier(record.fileKey)) &&
    (record.includeUser === undefined || typeof record.includeUser === "boolean"),
  "expansion/toggle": (record) =>
    hasExactKeys(record, ["type", "fileKey", "gapId"]) &&
    isIdentifier(record.fileKey) &&
    isIdentifier(record.gapId),
};

/**
 * Parse one review action strictly.
 *
 * `unsupported` and `invalid` stay distinct: a client speaking a newer vocabulary should
 * be told its action is unknown here, not that it is malformed, because the two call for
 * different responses (upgrade vs. fix).
 */
export function parseHunkReviewAction(value: unknown): HunkReviewParseResult<HunkReviewActionV1> {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") {
    return INVALID;
  }
  const type = record.type as ReviewIntentType;
  if (!HUNK_REVIEW_ACTION_TYPES.includes(type)) {
    // Either a vocabulary this build does not have, or one deliberately withheld; both
    // are "we will not do that", not "you said it wrong".
    return UNSUPPORTED;
  }
  return ACTION_PARSERS[type](record)
    ? { ok: true, value: record as unknown as HunkReviewActionV1 }
    : INVALID;
}

/**
 * Strip one action back to the intent it lowers to.
 *
 * The wire-only fields are removed here rather than being tolerated by the planner: core
 * refuses unknown fields, and an intent carrying transport residue would be a second
 * shape of the same thing.
 */
export function toReviewIntent(action: HunkReviewActionV1): ReviewIntent {
  if (action.type === "notes/start-draft") {
    const { expandedLineProof: _proof, ...intent } = action;
    return intent;
  }
  if (action.type === "notes/create-user") {
    const { expandedLineProof: _proof, target: _target, ...intent } = action;
    return intent;
  }
  return action;
}

/** Parse one action envelope, then the action inside it. */
export function parseHunkReviewActionEnvelope(
  value: unknown,
): HunkReviewParseResult<HunkReviewActionEnvelopeV1> {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      keysWith(["protocolVersion", "generation", "actor", "action"], {
        expectedStateRevision: record.expectedStateRevision,
      }),
    ) ||
    record.protocolVersion !== HUNK_REVIEW_PROTOCOL_VERSION ||
    parseReviewGeneration(record.generation) === undefined ||
    (record.expectedStateRevision !== undefined && !isIndex(record.expectedStateRevision)) ||
    parseHunkReviewActor(record.actor) === undefined
  ) {
    return INVALID;
  }
  const action = parseHunkReviewAction(record.action);
  return action.ok ? { ok: true, value: record as unknown as HunkReviewActionEnvelopeV1 } : action;
}

/** Parse one resource-read envelope; the request itself is core's parser (D5). */
export function parseHunkReviewResourceReadEnvelope(
  value: unknown,
): HunkReviewParseResult<HunkReviewResourceReadEnvelopeV1> {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["protocolVersion", "actor", "request"]) ||
    record.protocolVersion !== HUNK_REVIEW_PROTOCOL_VERSION ||
    parseHunkReviewActor(record.actor) === undefined ||
    parseReadReviewResourceRequest(record.request) === undefined
  ) {
    return INVALID;
  }
  return { ok: true, value: record as unknown as HunkReviewResourceReadEnvelopeV1 };
}

// -- Resource catalog transport ---------------------------------------------------------

/** The content type each resource kind is served as, so a parser cannot invent one. */
const RESOURCE_CONTENT_TYPE_BY_KIND: Record<ReviewResourceKind, string> = {
  "canonical-file": REVIEW_CANONICAL_FILE_CONTENT_TYPE,
  patch: REVIEW_PATCH_CONTENT_TYPE,
  source: REVIEW_SOURCE_CONTENT_TYPE,
};

/**
 * Parse one resource descriptor as a mirror receives it.
 *
 * The id is parsed back into the address it was built from and checked against the kind
 * and side the descriptor claims, so a descriptor whose id and fields disagree is refused
 * rather than mirrored — a mirror that trusted either half alone would serve reads for a
 * resource nobody can produce. Digests are validated with the shared canonical-form check
 * rather than an inline pattern (D5).
 */
export function parseHunkReviewResourceDescriptor(
  value: unknown,
): ReviewResourceDescriptorV1 | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      keysWith(["id", "generation", "fileKey", "kind", "contentType"], {
        byteLength: record.byteLength,
        digest: record.digest,
        side: record.side,
        sourceIdentity: record.sourceIdentity,
      }),
    )
  ) {
    return undefined;
  }

  const address = parseReviewResourceId(record.id);
  if (
    !address ||
    address.kind !== record.kind ||
    address.fileKey !== record.fileKey ||
    parseReviewGeneration(record.generation) === undefined ||
    record.contentType !== RESOURCE_CONTENT_TYPE_BY_KIND[address.kind]
  ) {
    return undefined;
  }
  // Measurements are set together or not at all: a descriptor with one of them cannot be
  // verified when read, so it is not a descriptor this protocol carries.
  if (
    (record.byteLength === undefined) !== (record.digest === undefined) ||
    (record.byteLength !== undefined && !isIndex(record.byteLength)) ||
    (record.digest !== undefined && !isReviewSha256Digest(record.digest))
  ) {
    return undefined;
  }
  if (address.kind === "source") {
    return record.side === address.side && isIdentifier(record.sourceIdentity)
      ? (record as unknown as ReviewResourceDescriptorV1)
      : undefined;
  }
  return record.side === undefined && record.sourceIdentity === undefined
    ? (record as unknown as ReviewResourceDescriptorV1)
    : undefined;
}

/**
 * One producer's published resource catalog, as a mirror holds it.
 *
 * The generation is stated once for the catalog and repeated by every descriptor in it;
 * a descriptor from another generation is not part of this catalog and is refused.
 */
export interface HunkReviewResourceCatalogV1 {
  generation: string;
  /**
   * Semantic file key by renderer-model id.
   *
   * Present because the session surface still addresses files by the renderer id it has
   * always used, while resources are addressed by the semantic key. Carrying the
   * correspondence is what lets a consumer of that file list ask for a file's patch
   * without guessing; it retires when the surface itself adopts semantic keys.
   */
  fileKeysByRuntimeId: Record<string, string>;
  resources: ReviewResourceDescriptorV1[];
}

/** Largest number of resources one catalog may declare. */
export const MAX_HUNK_REVIEW_CATALOG_RESOURCES = 15_000;

/** Parse one resource catalog, refusing any descriptor that is not of its generation. */
export function parseHunkReviewResourceCatalog(
  value: unknown,
): HunkReviewResourceCatalogV1 | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["generation", "fileKeysByRuntimeId", "resources"]) ||
    parseReviewGeneration(record.generation) === undefined ||
    !Array.isArray(record.resources) ||
    record.resources.length > MAX_HUNK_REVIEW_CATALOG_RESOURCES
  ) {
    return undefined;
  }

  const resources = record.resources.map(parseHunkReviewResourceDescriptor);
  if (
    resources.some(
      (resource) => resource === undefined || resource.generation !== record.generation,
    )
  ) {
    return undefined;
  }

  const fileKeys = asRecord(record.fileKeysByRuntimeId);
  // Every file offers at least a canonical form and a patch, so the resource count bounds
  // the file count. Deriving the bound rather than declaring a second file limit keeps the
  // two from drifting (D5).
  if (!fileKeys || Object.keys(fileKeys).length > record.resources.length) {
    return undefined;
  }
  if (
    Object.entries(fileKeys).some(
      ([runtimeId, fileKey]) => !isIdentifier(runtimeId) || !isIdentifier(fileKey),
    )
  ) {
    return undefined;
  }

  return {
    generation: record.generation as string,
    fileKeysByRuntimeId: fileKeys as Record<string, string>,
    resources: resources as ReviewResourceDescriptorV1[],
  };
}

/**
 * One producer's current publication position, as a mirror receives it.
 *
 * Exactly a `ReviewPublicationAddress`: the mirror's whole job is to order these through
 * `classifyReviewPublication`, and a second shape of "where the review is" would be a
 * second chance to compare them by a local rule (C1).
 */
export function parseHunkReviewPublicationAddress(
  value: unknown,
): ReviewPublicationAddress | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["generation", "stateRevision"]) ||
    parseReviewGeneration(record.generation) === undefined ||
    !isIndex(record.stateRevision)
  ) {
    return undefined;
  }
  return record as unknown as ReviewPublicationAddress;
}

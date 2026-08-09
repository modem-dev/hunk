import {
  MAX_WS_MESSAGE_BYTES,
  parseGenerationIdentifier,
  utf8ByteLength,
} from "@hunk/session-broker-core";
import type { ReviewAction } from "../core/review/actions";
import type {
  ReviewDocumentGeneration,
  ReviewNoteV1,
  ReviewResourceDescriptorV1,
  ReviewSide,
  ReviewFileChangeKind,
} from "../core/review/types";
import type {
  ReviewExpandedGapState,
  ReviewRevealIntent,
  ReviewSemanticSelection,
} from "../core/review/state";

export const HUNK_REVIEW_PROTOCOL_VERSION = 1 as const;
export const REVIEW_RESOURCE_CHUNK_BYTES = 256 * 1024;
export const MAX_REVIEW_SOURCE_RESOURCE_BYTES = 1_000_000;
export const MAX_REVIEW_RESOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_REVIEW_GENERATION_CACHE_BYTES = 128 * 1024 * 1024;
export const MAX_REVIEW_SESSION_CACHE_BYTES = 256 * 1024 * 1024;
export const MAX_REVIEW_DAEMON_CACHE_BYTES = 384 * 1024 * 1024;
export const MAX_REVIEW_DAEMON_CACHE_RESOURCES = 4_096;
export const MAX_REVIEW_DAEMON_INFLIGHT_BYTES = 128 * 1024 * 1024;
export const MAX_REVIEW_DAEMON_INFLIGHT_RESOURCES = 64;
export const MAX_REVIEW_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_REVIEW_PRODUCER_METADATA_BYTES = 6 * 1024 * 1024;
/** Bound the browser's combined manifest + mutable state snapshot plus JSON framing. */
export const MAX_BROWSER_REVIEW_SNAPSHOT_BYTES =
  MAX_REVIEW_MANIFEST_BYTES + MAX_REVIEW_PRODUCER_METADATA_BYTES + 256 * 1024;
/** Leave room for websocket framing and transport-added request identifiers. */
export const MAX_REVIEW_PRODUCER_ENVELOPE_BYTES = MAX_WS_MESSAGE_BYTES - 64 * 1024;
export const MAX_REVIEW_NOTE_BYTES = 256 * 1024;
export const MAX_REVIEW_RESOURCE_DESCRIPTORS = 15_000;

export interface HunkReviewManifestHunkV1 {
  index: number;
  header: string;
  oldRange?: [number, number];
  newRange?: [number, number];
}

export interface HunkReviewManifestFileV1 {
  key: string;
  runtimeId: string;
  path: string;
  previousPath?: string;
  changeKind: ReviewFileChangeKind;
  language?: string;
  agentSummary?: string;
  additions: number;
  deletions: number;
  statsTruncated: boolean;
  hunkCount: number;
  hasTrailingContext?: boolean;
  flags: {
    untracked: boolean;
    binary: boolean;
    tooLarge: boolean;
    partial: boolean;
  };
  patchResourceId: string;
  canonicalResourceId: string;
  sourceResourceIds: Partial<Record<ReviewSide, string>>;
  hunks: HunkReviewManifestHunkV1[];
  notes: ReviewNoteV1[];
}

/** Bounded document metadata mirrored by the daemon without patch or source bodies. */
export interface HunkReviewManifestV1 {
  version: typeof HUNK_REVIEW_PROTOCOL_VERSION;
  generation: ReviewDocumentGeneration;
  documentIdentity: string;
  changesetId: string;
  title: string;
  sourceLabel: string;
  summary?: string;
  agentSummary?: string;
  files: HunkReviewManifestFileV1[];
  resources: ReviewResourceDescriptorV1[];
  capabilities: {
    actions: HunkReviewActionV1["type"][];
    canReload?: boolean;
  };
}

export interface HunkReviewUserNoteInputV1 {
  fileKey: string;
  hunkIndex: number;
  side: ReviewSide;
  line: number;
  body: string;
  markup?: string;
}

/** Semantic renderer actions accepted by the authoritative source process. */
export type HunkReviewActionV1 =
  | Extract<
      ReviewAction,
      | { type: "selection/select" }
      | { type: "selection/set-line" }
      | { type: "filter/set" }
      | { type: "notes/set-visibility" }
    >
  | { type: "notes/create-user"; note: HunkReviewUserNoteInputV1 }
  | { type: "notes/update-user"; noteId: string; body: string; markup?: string }
  | { type: "notes/remove-user"; noteId: string }
  | { type: "notes/remove-live"; noteId: string }
  | { type: "expansion/toggle"; fileKey: string; gapId: string }
  | { type: "session/reload" }
  | { type: "trust/decide"; decision: "trusted" | "denied" };

export interface HunkReviewStateV1 {
  documentGeneration: ReviewDocumentGeneration;
  stateRevision: number;
  selection: ReviewSemanticSelection;
  reveal?: ReviewRevealIntent;
  filter: string;
  showAgentNotes: boolean;
  trustPromptRepoRoot?: string;
  notes: ReviewNoteV1[];
  expandedGaps?: ReviewExpandedGapState[];
  sourceStatusByFileKey?: Record<
    string,
    { kind: "idle" | "loading" | "loaded" | "error"; reason?: "too-large" }
  >;
}

export interface ReadReviewResourceInput {
  sessionId: string;
  generation: ReviewDocumentGeneration;
  resourceId: string;
  offset: number;
  length: number;
}

export interface ApplyReviewActionInput {
  sessionId: string;
  generation: ReviewDocumentGeneration;
  /** Required by non-selection mutations; selection remains last-writer-wins in one generation. */
  expectedStateRevision?: number;
  action: HunkReviewActionV1;
}

export interface GetReviewSnapshotInput {
  sessionId: string;
  generation: ReviewDocumentGeneration;
}

export interface ReviewResourceReadResult {
  kind: "review-resource";
  generation: ReviewDocumentGeneration;
  id: string;
  resourceId: string;
  offset: number;
  byteLength: number;
  encoding: "base64";
  data: string;
  contentDigest: string;
  contentSize: number;
  eof: boolean;
}

export interface ReviewSnapshotResult {
  kind: "review-snapshot";
  generation: ReviewDocumentGeneration;
  manifest: HunkReviewManifestV1;
  state: HunkReviewStateV1;
}

export interface ReviewActionResult {
  kind: "review-action";
  generation: ReviewDocumentGeneration;
  stateRevision: number;
  state: HunkReviewStateV1;
}

export type ReviewCommandErrorCode =
  | "stale-generation"
  | "stale-revision"
  | "cross-session"
  | "unknown-resource"
  | "invalid-range"
  | "invalid-command"
  | "invalid-generation"
  | "invalid-action"
  | "unsupported-action"
  | "resource-too-large";

export interface ReviewCommandErrorResult {
  kind: "review-error";
  error: {
    code: ReviewCommandErrorCode;
    message: string;
    currentGeneration?: ReviewDocumentGeneration;
  };
}

/** Return whether a declared content digest is one canonical SHA-256 hex value. */
export function isReviewSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
}

/** Parse one complete resource-read input without accepting omitted or unknown fields. */
export function parseReadReviewResourceInput(value: unknown): ReadReviewResourceInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5 ||
    Object.keys(record).some(
      (key) => !["sessionId", "generation", "resourceId", "offset", "length"].includes(key),
    ) ||
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    parseGenerationIdentifier(record.generation) === null ||
    typeof record.resourceId !== "string" ||
    record.resourceId.length === 0 ||
    !Number.isInteger(record.offset) ||
    !Number.isInteger(record.length)
  )
    return null;
  return record as unknown as ReadReviewResourceInput;
}

/** Parse one complete action input before inspecting its discriminated action body. */
export function parseApplyReviewActionInput(value: unknown): ApplyReviewActionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    (Object.keys(record).length !== 3 && Object.keys(record).length !== 4) ||
    Object.keys(record).some(
      (key) => !["sessionId", "generation", "expectedStateRevision", "action"].includes(key),
    ) ||
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    parseGenerationIdentifier(record.generation) === null ||
    (record.expectedStateRevision !== undefined &&
      (!Number.isSafeInteger(record.expectedStateRevision) ||
        (record.expectedStateRevision as number) < 0)) ||
    !("action" in record)
  )
    return null;
  return record as unknown as ApplyReviewActionInput;
}

/** Parse one complete reconnect-snapshot input without optional targeting ambiguity. */
export function parseGetReviewSnapshotInput(value: unknown): GetReviewSnapshotInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    Object.keys(record).some((key) => !["sessionId", "generation"].includes(key)) ||
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    parseGenerationIdentifier(record.generation) === null
  )
    return null;
  return record as unknown as GetReviewSnapshotInput;
}

/** Fail before transport when one complete producer envelope cannot fit safely in one frame. */
export function assertReviewProducerEnvelopeWithinBounds(value: unknown, label: string) {
  if (utf8ByteLength(JSON.stringify(value)) > MAX_REVIEW_PRODUCER_ENVELOPE_BYTES) {
    throw new Error(`${label} exceeds the bounded session websocket envelope limit.`);
  }
}

export type HunkReviewCommandResult =
  | ReviewResourceReadResult
  | ReviewSnapshotResult
  | ReviewActionResult
  | ReviewCommandErrorResult;

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
import type { ReviewSemanticSelection } from "../core/review/state";

export const HUNK_REVIEW_PROTOCOL_VERSION = 1 as const;
export const REVIEW_RESOURCE_CHUNK_BYTES = 256 * 1024;
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
  };
}

/** Small semantic action subset exposed through the source-process command bridge. */
export type HunkReviewActionV1 = Extract<
  ReviewAction,
  | { type: "selection/select" }
  | { type: "selection/set-line" }
  | { type: "filter/set" }
  | { type: "notes/set-visibility" }
>;

export interface HunkReviewStateV1 {
  documentGeneration: ReviewDocumentGeneration;
  stateRevision: number;
  selection: ReviewSemanticSelection;
  filter: string;
  showAgentNotes: boolean;
  notes: ReviewNoteV1[];
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
    Object.keys(record).length !== 3 ||
    Object.keys(record).some((key) => !["sessionId", "generation", "action"].includes(key)) ||
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    parseGenerationIdentifier(record.generation) === null ||
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

import {
  MAX_WS_MESSAGE_BYTES,
  parseGenerationIdentifier,
  utf8ByteLength,
} from "@hunk/session-broker-core";
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

/** Capacity failure that terminal-only sessions may safely degrade around. */
export class ReviewProducerCapacityError extends Error {
  override readonly name = "ReviewProducerCapacityError";
}

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

export interface HunkReviewSelectionV1 {
  fileKey: string | null;
  hunkIndex: number;
  side?: ReviewSide;
  line?: number;
  contextDigest?: string;
}

export interface HunkReviewRevealV1 {
  kind: "hunk" | "file-top" | "line";
  scrollToNote?: boolean;
}

/** Versioned wire actions accepted from browser review clients. */
export type HunkReviewActionV1 =
  | {
      type: "selection/select";
      selection: HunkReviewSelectionV1;
      reveal?: HunkReviewRevealV1;
    }
  | {
      type: "selection/set-line";
      fileKey: string;
      hunkIndex: number;
      side: ReviewSide;
      line: number;
      contextDigest?: string;
      reveal?: boolean;
    }
  | { type: "filter/set"; filter: string }
  | { type: "notes/set-visibility"; visible: boolean }
  | { type: "notes/create-user"; note: HunkReviewUserNoteInputV1 }
  | { type: "notes/update-user"; noteId: string; body: string; markup?: string }
  | { type: "notes/remove-user"; noteId: string }
  | { type: "notes/remove-live"; noteId: string }
  | { type: "expansion/toggle"; fileKey: string; gapId: string }
  | { type: "session/reload" }
  | { type: "trust/decide"; decision: "trusted" | "denied" };

export type HunkReviewActionParseResult = HunkReviewActionV1 | "invalid" | "unsupported";

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

/** Return whether one protocol object contains exactly the allowed fields. */
function hasExactKeys(record: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

/** Strictly parse one nested browser action while distinguishing unknown action versions. */
export function parseHunkReviewActionV1(action: unknown): HunkReviewActionParseResult {
  if (!action || typeof action !== "object" || Array.isArray(action)) return "invalid";
  const candidate = action as Record<string, unknown>;
  if (typeof candidate.type !== "string") return "invalid";
  switch (candidate.type) {
    case "filter/set":
      return hasExactKeys(candidate, ["type", "filter"]) &&
        typeof candidate.filter === "string" &&
        candidate.filter.length <= 16_384
        ? (candidate as unknown as HunkReviewActionV1)
        : "invalid";
    case "notes/set-visibility":
      return hasExactKeys(candidate, ["type", "visible"]) && typeof candidate.visible === "boolean"
        ? (candidate as unknown as HunkReviewActionV1)
        : "invalid";
    case "selection/select": {
      if (
        !hasExactKeys(candidate, [
          "type",
          "selection",
          ...(candidate.reveal === undefined ? [] : ["reveal"]),
        ])
      )
        return "invalid";
      const selection = candidate.selection;
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) return "invalid";
      const selected = selection as Record<string, unknown>;
      const selectionKeys = [
        "fileKey",
        "hunkIndex",
        ...(selected.side === undefined ? [] : ["side"]),
        ...(selected.line === undefined ? [] : ["line"]),
        ...(selected.contextDigest === undefined ? [] : ["contextDigest"]),
      ];
      if (
        !hasExactKeys(selected, selectionKeys) ||
        !(selected.fileKey === null || typeof selected.fileKey === "string") ||
        !Number.isInteger(selected.hunkIndex) ||
        (selected.hunkIndex as number) < 0 ||
        (selected.side !== undefined && selected.side !== "old" && selected.side !== "new") ||
        (selected.line !== undefined &&
          (!Number.isInteger(selected.line) || (selected.line as number) <= 0)) ||
        (selected.contextDigest !== undefined && typeof selected.contextDigest !== "string")
      )
        return "invalid";
      if (candidate.reveal !== undefined) {
        const reveal = candidate.reveal;
        if (!reveal || typeof reveal !== "object" || Array.isArray(reveal)) return "invalid";
        const revealed = reveal as Record<string, unknown>;
        const revealKeys = [
          "kind",
          ...(revealed.scrollToNote === undefined ? [] : ["scrollToNote"]),
        ];
        if (
          !hasExactKeys(revealed, revealKeys) ||
          (revealed.kind !== "hunk" && revealed.kind !== "file-top" && revealed.kind !== "line") ||
          (revealed.scrollToNote !== undefined && typeof revealed.scrollToNote !== "boolean")
        )
          return "invalid";
      }
      return candidate as unknown as HunkReviewActionV1;
    }
    case "selection/set-line": {
      const keys = [
        "type",
        "fileKey",
        "hunkIndex",
        "side",
        "line",
        ...(candidate.contextDigest === undefined ? [] : ["contextDigest"]),
        ...(candidate.reveal === undefined ? [] : ["reveal"]),
      ];
      return hasExactKeys(candidate, keys) &&
        typeof candidate.fileKey === "string" &&
        Number.isInteger(candidate.hunkIndex) &&
        (candidate.hunkIndex as number) >= 0 &&
        (candidate.side === "old" || candidate.side === "new") &&
        Number.isInteger(candidate.line) &&
        (candidate.line as number) > 0 &&
        (candidate.contextDigest === undefined || typeof candidate.contextDigest === "string") &&
        (candidate.reveal === undefined || typeof candidate.reveal === "boolean")
        ? (candidate as unknown as HunkReviewActionV1)
        : "invalid";
    }
    case "notes/create-user": {
      const note = candidate.note;
      if (
        !hasExactKeys(candidate, ["type", "note"]) ||
        !note ||
        typeof note !== "object" ||
        Array.isArray(note)
      )
        return "invalid";
      const value = note as Record<string, unknown>;
      return hasExactKeys(value, [
        "fileKey",
        "hunkIndex",
        "side",
        "line",
        "body",
        ...(value.markup === undefined ? [] : ["markup"]),
      ]) &&
        typeof value.fileKey === "string" &&
        Number.isInteger(value.hunkIndex) &&
        (value.hunkIndex as number) >= 0 &&
        (value.side === "old" || value.side === "new") &&
        Number.isInteger(value.line) &&
        (value.line as number) > 0 &&
        typeof value.body === "string" &&
        utf8ByteLength(value.body) <= MAX_REVIEW_NOTE_BYTES &&
        (value.markup === undefined ||
          (typeof value.markup === "string" &&
            utf8ByteLength(value.markup) <= MAX_REVIEW_NOTE_BYTES))
        ? (candidate as unknown as HunkReviewActionV1)
        : "invalid";
    }
    case "notes/update-user":
      return hasExactKeys(candidate, [
        "type",
        "noteId",
        "body",
        ...(candidate.markup === undefined ? [] : ["markup"]),
      ]) &&
        typeof candidate.noteId === "string" &&
        typeof candidate.body === "string" &&
        utf8ByteLength(candidate.body) <= MAX_REVIEW_NOTE_BYTES &&
        (candidate.markup === undefined ||
          (typeof candidate.markup === "string" &&
            utf8ByteLength(candidate.markup) <= MAX_REVIEW_NOTE_BYTES))
        ? (candidate as unknown as HunkReviewActionV1)
        : "invalid";
    case "notes/remove-user":
    case "notes/remove-live":
      return hasExactKeys(candidate, ["type", "noteId"]) && typeof candidate.noteId === "string"
        ? (candidate as unknown as HunkReviewActionV1)
        : "invalid";
    case "expansion/toggle":
      return hasExactKeys(candidate, ["type", "fileKey", "gapId"]) &&
        typeof candidate.fileKey === "string" &&
        typeof candidate.gapId === "string"
        ? (candidate as unknown as HunkReviewActionV1)
        : "invalid";
    case "session/reload":
      return hasExactKeys(candidate, ["type"])
        ? (candidate as unknown as HunkReviewActionV1)
        : "invalid";
    case "trust/decide":
      return hasExactKeys(candidate, ["type", "decision"]) &&
        (candidate.decision === "trusted" || candidate.decision === "denied")
        ? (candidate as unknown as HunkReviewActionV1)
        : "invalid";
    default:
      return "unsupported";
  }
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
    throw new ReviewProducerCapacityError(
      `${label} exceeds the bounded session websocket envelope limit.`,
    );
  }
}

export type HunkReviewCommandResult =
  | ReviewResourceReadResult
  | ReviewSnapshotResult
  | ReviewActionResult
  | ReviewCommandErrorResult;

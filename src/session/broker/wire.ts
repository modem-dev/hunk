import { EXPERIMENTAL_FEATURES, type ExperimentalFeature } from "../../core/run/experimental";
import type { CliInput } from "../../core/run/commandInputs";
import {
  MAX_REGISTRATION_FILES,
  MAX_REGISTRATION_HUNKS_PER_FILE,
  MAX_REGISTRATION_PATCH_BYTES,
  MAX_SNAPSHOT_LIVE_COMMENTS,
  BrokerProtocolError,
  MAX_SNAPSHOT_REVIEW_NOTES,
  brokerWireParsers,
  parseBrokerString,
  parseExactBrokerRecord,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
} from "@hunk/session-broker-core";
import {
  parseHunkReviewPublicationAddress,
  parseHunkReviewResourceCatalog,
} from "../reviewProtocol";
import { isReviewSha256Digest } from "../../core/review/validation";
import { parseExtensionReviewDescriptor } from "../../core/reviewDescriptor";
import type { HunkSessionRegistration, HunkSessionSnapshot } from "../types";
import type {
  HunkSessionInfo,
  HunkSessionState,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
  SessionReviewFile,
  SessionReviewHunk,
} from "../types";

const REVIEW_INPUT_KINDS = new Set<CliInput["kind"]>([
  "vcs",
  "show",
  "stash-show",
  "diff",
  "patch",
  "difftool",
]);
const EXPERIMENTAL_FEATURE_SET = new Set<string>(EXPERIMENTAL_FEATURES);

/** Parse unique recognized experimental feature ids without silently dropping malformed entries. */
function parseExperimentalFeatures(value: unknown): ExperimentalFeature[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BrokerProtocolError("invalid-app-payload");
  if (
    value.some((feature) => typeof feature !== "string" || !EXPERIMENTAL_FEATURE_SET.has(feature))
  ) {
    throw new BrokerProtocolError("invalid-app-payload");
  }
  return [...new Set(value)] as ExperimentalFeature[];
}

/** Read one app-owned object with an exact field set. */
function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  return parseExactBrokerRecord(value, required, optional);
}

/** Parse one optional diff-side line range tuple when the payload shape matches. */
function parseOptionalRange(value: unknown): [number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new BrokerProtocolError("invalid-app-payload");
  }
  const start = brokerWireParsers.parseNonNegativeInt(value[0]);
  const end = brokerWireParsers.parseNonNegativeInt(value[1]);
  if (start === null || end === null) throw new BrokerProtocolError("invalid-app-payload");
  return [start, end];
}

/** Parse one registered review hunk from the app-owned session payload. */
function parseSessionReviewHunk(value: unknown): SessionReviewHunk | null {
  const record = exactRecord(value, ["index", "header"], ["oldRange", "newRange"]);

  const index = brokerWireParsers.parseNonNegativeInt(record.index);
  const header = brokerWireParsers.parseRequiredString(record.header);
  if (index === null || header === null) {
    return null;
  }

  return {
    index,
    header,
    oldRange: parseOptionalRange(record.oldRange),
    newRange: parseOptionalRange(record.newRange),
  };
}

/** Parse one registered review file from the app-owned session payload. */
function parseSessionReviewFile(value: unknown): SessionReviewFile | null {
  const record = exactRecord(
    value,
    ["id", "path", "additions", "deletions", "hunks"],
    ["previousPath", "patch", "hunkCount"],
  );

  const id = brokerWireParsers.parseRequiredString(record.id);
  const path = brokerWireParsers.parseRequiredString(record.path);
  const additions = brokerWireParsers.parseNonNegativeInt(record.additions);
  const deletions = brokerWireParsers.parseNonNegativeInt(record.deletions);
  if (id === null || path === null || additions === null || deletions === null) {
    return null;
  }

  if (!Array.isArray(record.hunks) || record.hunks.length > MAX_REGISTRATION_HUNKS_PER_FILE) {
    return null;
  }
  const assertedHunkCount =
    record.hunkCount === undefined
      ? undefined
      : brokerWireParsers.parseNonNegativeInt(record.hunkCount);
  if (
    record.hunkCount !== undefined &&
    (assertedHunkCount === null || assertedHunkCount !== record.hunks.length)
  ) {
    return null;
  }

  const hunks = record.hunks.map(parseSessionReviewHunk);
  if (hunks.some((hunk) => hunk === null)) {
    return null;
  }

  // Reject files whose patch text alone would blow the per-file memory budget instead of
  // silently dropping it, so an oversized registration fails loudly rather than half-loading.
  const patch =
    record.patch === undefined
      ? undefined
      : parseBrokerString(record.patch, {
          maxBytes: MAX_REGISTRATION_PATCH_BYTES,
        });

  return {
    id,
    path,
    previousPath: brokerWireParsers.parseOptionalString(record.previousPath),
    additions,
    deletions,
    hunkCount: (hunks as SessionReviewHunk[]).length,
    patch,
    hunks: hunks as SessionReviewHunk[],
  };
}

/** Parse one review input kind supported by live review sessions. */
function parseReviewInputKind(value: unknown): CliInput["kind"] | null {
  if (typeof value !== "string" || !REVIEW_INPUT_KINDS.has(value as CliInput["kind"])) {
    return null;
  }

  return value as CliInput["kind"];
}

/** Parse one live comment summary from the app-owned snapshot payload. */
function parseSessionLiveCommentSummary(value: unknown): SessionLiveCommentSummary | null {
  const record = exactRecord(
    value,
    ["commentId", "filePath", "hunkIndex", "summary", "createdAt", "line", "side"],
    ["rationale", "author"],
  );

  const commentId = brokerWireParsers.parseRequiredString(record.commentId);
  const filePath = brokerWireParsers.parseRequiredString(record.filePath);
  const hunkIndex = brokerWireParsers.parseNonNegativeInt(record.hunkIndex);
  const summary = brokerWireParsers.parseRequiredString(record.summary);
  const createdAt = brokerWireParsers.parseRequiredString(record.createdAt);
  const line = brokerWireParsers.parsePositiveInt(record.line);
  const side = record.side === "old" || record.side === "new" ? record.side : null;
  if (
    commentId === null ||
    filePath === null ||
    hunkIndex === null ||
    summary === null ||
    createdAt === null ||
    line === null ||
    side === null
  ) {
    return null;
  }

  return {
    commentId,
    filePath,
    hunkIndex,
    side,
    line,
    summary,
    rationale: brokerWireParsers.parseOptionalString(record.rationale),
    author: brokerWireParsers.parseOptionalString(record.author),
    createdAt,
  };
}

/** Parse one review note summary from the app-owned snapshot payload. */
function parseSessionReviewNoteSummary(value: unknown): SessionReviewNoteSummary | null {
  const record = exactRecord(
    value,
    ["noteId", "source", "filePath", "body", "createdAt"],
    ["parentId", "hunkIndex", "oldRange", "newRange", "title", "author", "updatedAt", "editable"],
  );

  const noteId = brokerWireParsers.parseRequiredString(record.noteId);
  const filePath = brokerWireParsers.parseRequiredString(record.filePath);
  const body = brokerWireParsers.parseRequiredString(record.body);
  const createdAt = brokerWireParsers.parseRequiredString(record.createdAt);
  const source =
    record.source === "ai" || record.source === "agent" || record.source === "user"
      ? record.source
      : null;
  if (
    noteId === null ||
    filePath === null ||
    body === null ||
    createdAt === null ||
    source === null
  ) {
    return null;
  }

  const hunkIndex =
    record.hunkIndex === undefined
      ? undefined
      : brokerWireParsers.parseNonNegativeInt(record.hunkIndex);
  if (record.hunkIndex !== undefined && hunkIndex === null) return null;
  if (record.editable !== undefined && typeof record.editable !== "boolean") return null;

  return {
    noteId,
    parentId: brokerWireParsers.parseOptionalString(record.parentId),
    source,
    filePath,
    hunkIndex: hunkIndex ?? undefined,
    oldRange: parseOptionalRange(record.oldRange),
    newRange: parseOptionalRange(record.newRange),
    body,
    title: brokerWireParsers.parseOptionalString(record.title),
    author: brokerWireParsers.parseOptionalString(record.author),
    createdAt,
    updatedAt: brokerWireParsers.parseOptionalString(record.updatedAt),
    editable: typeof record.editable === "boolean" ? record.editable : source === "user",
  };
}

/** Parse the app-owned registration info embedded inside one broker registration envelope. */
function parseHunkSessionInfo(value: unknown): HunkSessionInfo | null {
  const record = exactRecord(
    value,
    ["inputKind", "title", "sourceLabel", "files"],
    ["experimentalFeatures", "review", "reviewCatalog", "reviewCapabilityDigest"],
  );
  if (!Array.isArray(record.files) || record.files.length > MAX_REGISTRATION_FILES) return null;

  const inputKind = parseReviewInputKind(record.inputKind);
  const title = brokerWireParsers.parseRequiredString(record.title);
  const sourceLabel = brokerWireParsers.parseRequiredString(record.sourceLabel);
  if (inputKind === null || title === null || sourceLabel === null) {
    return null;
  }

  const files = record.files.map(parseSessionReviewFile);
  if (files.some((file) => file === null)) {
    return null;
  }

  // The review catalog is parsed by the wire protocol itself, so the broker never grows a
  // second opinion about what a resource descriptor is (`docs/browser-review-seam-audit.md`,
  // D5). A session from before the mirror existed sends none; one that sends a malformed
  // catalog is refused outright rather than mirrored half-parsed.
  const reviewCatalog =
    record.reviewCatalog === undefined
      ? undefined
      : parseHunkReviewResourceCatalog(record.reviewCatalog);
  if (record.reviewCatalog !== undefined && reviewCatalog === undefined) {
    return null;
  }

  // The capability verifier is a digest and nothing else, checked with the shared
  // canonical-form validator rather than an inline pattern (D5). A registration that
  // offers something else in its place is refused rather than mirrored with an
  // unverifiable credential attached.
  const reviewCapabilityDigest = record.reviewCapabilityDigest;
  if (reviewCapabilityDigest !== undefined && !isReviewSha256Digest(reviewCapabilityDigest)) {
    return null;
  }
  const review =
    record.review === undefined ? undefined : parseExtensionReviewDescriptor(record.review);
  if (record.review !== undefined && review === null) return null;

  return {
    inputKind,
    title,
    sourceLabel,
    experimentalFeatures: parseExperimentalFeatures(record.experimentalFeatures),
    ...(review ? { review } : {}),
    files: files as SessionReviewFile[],
    ...(reviewCatalog ? { reviewCatalog } : {}),
    ...(reviewCapabilityDigest ? { reviewCapabilityDigest } : {}),
  };
}

/** Parse the app-owned snapshot state embedded inside one broker snapshot envelope. */
function parseHunkSessionState(value: unknown): HunkSessionState | null {
  const record = exactRecord(
    value,
    ["liveComments", "selectedHunkIndex", "showAgentNotes"],
    [
      "selectedFileId",
      "selectedFilePath",
      "selectedHunkOldRange",
      "selectedHunkNewRange",
      "noteMarkupWidth",
      "liveCommentCount",
      "reviewNoteCount",
      "reviewNotes",
      "reviewPublication",
    ],
  );
  if (
    !Array.isArray(record.liveComments) ||
    record.liveComments.length > MAX_SNAPSHOT_LIVE_COMMENTS ||
    (Array.isArray(record.reviewNotes) && record.reviewNotes.length > MAX_SNAPSHOT_REVIEW_NOTES)
  ) {
    return null;
  }

  const selectedHunkIndex = brokerWireParsers.parseNonNegativeInt(record.selectedHunkIndex);
  const showAgentNotes = typeof record.showAgentNotes === "boolean" ? record.showAgentNotes : null;
  if (selectedHunkIndex === null || showAgentNotes === null) {
    return null;
  }

  // Where the review sits is the one fact the mirror orders on, so it is parsed as the
  // shared publication address rather than as two loose numbers (C1).
  const reviewPublication =
    record.reviewPublication === undefined
      ? undefined
      : parseHunkReviewPublicationAddress(record.reviewPublication);
  if (record.reviewPublication !== undefined && reviewPublication === undefined) {
    return null;
  }

  if (record.reviewNotes !== undefined && !Array.isArray(record.reviewNotes)) return null;
  const assertedLiveCommentCount =
    record.liveCommentCount === undefined
      ? undefined
      : brokerWireParsers.parseNonNegativeInt(record.liveCommentCount);
  const assertedReviewNoteCount =
    record.reviewNoteCount === undefined
      ? undefined
      : brokerWireParsers.parseNonNegativeInt(record.reviewNoteCount);
  if (
    (record.liveCommentCount !== undefined && assertedLiveCommentCount === null) ||
    (record.reviewNoteCount !== undefined && assertedReviewNoteCount === null)
  ) {
    return null;
  }
  const liveComments = record.liveComments.map(parseSessionLiveCommentSummary);
  const reviewNotes = (record.reviewNotes ?? []).map(parseSessionReviewNoteSummary);
  if (
    liveComments.some((comment) => comment === null) ||
    reviewNotes.some((note) => note === null) ||
    (assertedLiveCommentCount !== undefined && assertedLiveCommentCount !== liveComments.length) ||
    (assertedReviewNoteCount !== undefined && assertedReviewNoteCount !== reviewNotes.length)
  ) {
    return null;
  }
  const noteMarkupWidth =
    record.noteMarkupWidth === undefined
      ? undefined
      : brokerWireParsers.parseNonNegativeInt(record.noteMarkupWidth);
  if (record.noteMarkupWidth !== undefined && noteMarkupWidth === null) return null;

  return {
    selectedFileId: brokerWireParsers.parseOptionalString(record.selectedFileId),
    selectedFilePath: brokerWireParsers.parseOptionalString(record.selectedFilePath),
    selectedHunkIndex,
    selectedHunkOldRange: parseOptionalRange(record.selectedHunkOldRange),
    selectedHunkNewRange: parseOptionalRange(record.selectedHunkNewRange),
    showAgentNotes,
    noteMarkupWidth: noteMarkupWidth ?? undefined,
    liveCommentCount: liveComments.length,
    liveComments: liveComments as SessionLiveCommentSummary[],
    reviewNoteCount: reviewNotes.length,
    reviewNotes: reviewNotes as SessionReviewNoteSummary[],
    ...(reviewPublication ? { reviewPublication } : {}),
  };
}

/** Parse one Hunk session registration payload from the websocket wire format. */
export function parseSessionRegistration(value: unknown): HunkSessionRegistration | null {
  return parseSessionRegistrationEnvelope(value, parseHunkSessionInfo);
}

/** Parse one Hunk session snapshot payload from the websocket wire format. */
export function parseSessionSnapshot(value: unknown): HunkSessionSnapshot | null {
  return parseSessionSnapshotEnvelope(value, parseHunkSessionState);
}

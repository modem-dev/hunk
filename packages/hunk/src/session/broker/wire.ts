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

/** Where one wire parse rejected a payload: the parser name and the top-level key path only. */
export interface SessionWireRejection {
  parser: string;
  path: string;
}

/**
 * Threads the key path through nested parsers and records the innermost rejection.
 *
 * Parsers reject either by returning null or by throwing a `BrokerProtocolError` from an exact
 * record read; both routes land in `reject`, and the first (innermost) record wins so a later
 * outer null cannot overwrite the useful location.
 */
interface WireParseContext {
  path: string;
  slot: { rejection: SessionWireRejection | null };
}

/** Create a fresh root context for one top-level parse. */
function rootContext(): WireParseContext {
  return { path: "", slot: { rejection: null } };
}

/** Derive the context for one nested key while sharing the rejection slot. */
function child(context: WireParseContext, key: string): WireParseContext {
  return { path: context.path ? `${context.path}.${key}` : key, slot: context.slot };
}

/** Record the innermost rejection for a parser and return the null it reports. */
function reject(context: WireParseContext, parser: string): null {
  context.slot.rejection ??= { parser, path: context.path };
  return null;
}

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

/** Read one app-owned object with an exact field set, recording the parser when it throws. */
function exactRecord(
  context: WireParseContext,
  parser: string,
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  try {
    return parseExactBrokerRecord(value, required, optional);
  } catch (error) {
    reject(context, parser);
    throw error;
  }
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
function parseSessionReviewHunk(
  value: unknown,
  context: WireParseContext,
): SessionReviewHunk | null {
  const parser = "parseSessionReviewHunk";
  const record = exactRecord(context, parser, value, ["index", "header"], ["oldRange", "newRange"]);

  const index = brokerWireParsers.parseNonNegativeInt(record.index);
  const header = brokerWireParsers.parseRequiredString(record.header);
  if (index === null || header === null) {
    return reject(context, parser);
  }

  return {
    index,
    header,
    oldRange: parseOptionalRange(record.oldRange),
    newRange: parseOptionalRange(record.newRange),
  };
}

/** Parse one registered review file from the app-owned session payload. */
function parseSessionReviewFile(
  value: unknown,
  context: WireParseContext,
): SessionReviewFile | null {
  const parser = "parseSessionReviewFile";
  const record = exactRecord(
    context,
    parser,
    value,
    ["id", "path", "additions", "deletions", "hunks"],
    ["previousPath", "patch", "hunkCount"],
  );

  const id = brokerWireParsers.parseRequiredString(record.id);
  const path = brokerWireParsers.parseRequiredString(record.path);
  const additions = brokerWireParsers.parseNonNegativeInt(record.additions);
  const deletions = brokerWireParsers.parseNonNegativeInt(record.deletions);
  if (id === null || path === null || additions === null || deletions === null) {
    return reject(context, parser);
  }

  if (!Array.isArray(record.hunks) || record.hunks.length > MAX_REGISTRATION_HUNKS_PER_FILE) {
    return reject(context, parser);
  }
  const assertedHunkCount =
    record.hunkCount === undefined
      ? undefined
      : brokerWireParsers.parseNonNegativeInt(record.hunkCount);
  if (
    record.hunkCount !== undefined &&
    (assertedHunkCount === null || assertedHunkCount !== record.hunks.length)
  ) {
    return reject(context, parser);
  }

  const hunks = record.hunks.map((hunk, index) =>
    parseSessionReviewHunk(hunk, child(context, `hunks[${index}]`)),
  );
  if (hunks.some((hunk) => hunk === null)) {
    return reject(context, parser);
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
function parseSessionLiveCommentSummary(
  value: unknown,
  context: WireParseContext,
): SessionLiveCommentSummary | null {
  const parser = "parseSessionLiveCommentSummary";
  const record = exactRecord(
    context,
    parser,
    value,
    ["commentId", "filePath", "hunkIndex", "summary", "createdAt", "line", "side"],
    ["parentId", "rationale", "author"],
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
    return reject(context, parser);
  }

  return {
    commentId,
    parentId: brokerWireParsers.parseOptionalString(record.parentId),
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
function parseSessionReviewNoteSummary(
  value: unknown,
  context: WireParseContext,
): SessionReviewNoteSummary | null {
  const parser = "parseSessionReviewNoteSummary";
  const record = exactRecord(
    context,
    parser,
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
    return reject(context, parser);
  }

  const hunkIndex =
    record.hunkIndex === undefined
      ? undefined
      : brokerWireParsers.parseNonNegativeInt(record.hunkIndex);
  if (record.hunkIndex !== undefined && hunkIndex === null) return reject(context, parser);
  if (record.editable !== undefined && typeof record.editable !== "boolean") {
    return reject(context, parser);
  }

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
function parseHunkSessionInfo(value: unknown, context: WireParseContext): HunkSessionInfo | null {
  const parser = "parseHunkSessionInfo";
  const record = exactRecord(
    context,
    parser,
    value,
    ["inputKind", "title", "sourceLabel", "files"],
    ["experimentalFeatures", "review", "reviewCatalog", "reviewCapabilityDigest"],
  );
  if (!Array.isArray(record.files) || record.files.length > MAX_REGISTRATION_FILES) {
    return reject(context, parser);
  }

  const inputKind = parseReviewInputKind(record.inputKind);
  const title = brokerWireParsers.parseRequiredString(record.title);
  const sourceLabel = brokerWireParsers.parseRequiredString(record.sourceLabel);
  if (inputKind === null || title === null || sourceLabel === null) {
    return reject(context, parser);
  }

  const files = record.files.map((file, index) =>
    parseSessionReviewFile(file, child(context, `files[${index}]`)),
  );
  if (files.some((file) => file === null)) {
    return reject(context, parser);
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
    return reject(child(context, "reviewCatalog"), "parseHunkReviewResourceCatalog");
  }

  // The capability verifier is a digest and nothing else, checked with the shared
  // canonical-form validator rather than an inline pattern (D5). A registration that
  // offers something else in its place is refused rather than mirrored with an
  // unverifiable credential attached.
  const reviewCapabilityDigest = record.reviewCapabilityDigest;
  if (reviewCapabilityDigest !== undefined && !isReviewSha256Digest(reviewCapabilityDigest)) {
    return reject(child(context, "reviewCapabilityDigest"), "isReviewSha256Digest");
  }
  const review =
    record.review === undefined ? undefined : parseExtensionReviewDescriptor(record.review);
  if (record.review !== undefined && review === null) {
    return reject(child(context, "review"), "parseExtensionReviewDescriptor");
  }

  let experimentalFeatures: ExperimentalFeature[];
  try {
    experimentalFeatures = parseExperimentalFeatures(record.experimentalFeatures);
  } catch (error) {
    reject(child(context, "experimentalFeatures"), "parseExperimentalFeatures");
    throw error;
  }

  return {
    inputKind,
    title,
    sourceLabel,
    experimentalFeatures,
    ...(review ? { review } : {}),
    files: files as SessionReviewFile[],
    ...(reviewCatalog ? { reviewCatalog } : {}),
    ...(reviewCapabilityDigest ? { reviewCapabilityDigest } : {}),
  };
}

/** Parse the app-owned snapshot state embedded inside one broker snapshot envelope. */
function parseHunkSessionState(value: unknown, context: WireParseContext): HunkSessionState | null {
  const parser = "parseHunkSessionState";
  const record = exactRecord(
    context,
    parser,
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
    return reject(context, parser);
  }

  const selectedHunkIndex = brokerWireParsers.parseNonNegativeInt(record.selectedHunkIndex);
  const showAgentNotes = typeof record.showAgentNotes === "boolean" ? record.showAgentNotes : null;
  if (selectedHunkIndex === null || showAgentNotes === null) {
    return reject(context, parser);
  }

  // Where the review sits is the one fact the mirror orders on, so it is parsed as the
  // shared publication address rather than as two loose numbers (C1).
  const reviewPublication =
    record.reviewPublication === undefined
      ? undefined
      : parseHunkReviewPublicationAddress(record.reviewPublication);
  if (record.reviewPublication !== undefined && reviewPublication === undefined) {
    return reject(child(context, "reviewPublication"), "parseHunkReviewPublicationAddress");
  }

  if (record.reviewNotes !== undefined && !Array.isArray(record.reviewNotes)) {
    return reject(context, parser);
  }
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
    return reject(context, parser);
  }
  const liveComments = record.liveComments.map((comment, index) =>
    parseSessionLiveCommentSummary(comment, child(context, `liveComments[${index}]`)),
  );
  const reviewNotes = (record.reviewNotes ?? []).map((note, index) =>
    parseSessionReviewNoteSummary(note, child(context, `reviewNotes[${index}]`)),
  );
  if (
    liveComments.some((comment) => comment === null) ||
    reviewNotes.some((note) => note === null) ||
    (assertedLiveCommentCount !== undefined && assertedLiveCommentCount !== liveComments.length) ||
    (assertedReviewNoteCount !== undefined && assertedReviewNoteCount !== reviewNotes.length)
  ) {
    return reject(context, parser);
  }
  const noteMarkupWidth =
    record.noteMarkupWidth === undefined
      ? undefined
      : brokerWireParsers.parseNonNegativeInt(record.noteMarkupWidth);
  if (record.noteMarkupWidth !== undefined && noteMarkupWidth === null) {
    return reject(context, parser);
  }

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

/** Parse one registration with a shared context so the rejection location can be read back. */
function parseSessionRegistrationWith(value: unknown, context: WireParseContext) {
  const parsed = parseSessionRegistrationEnvelope(value, (info) =>
    parseHunkSessionInfo(info, child(context, "info")),
  );
  if (parsed === null) reject(context, "parseSessionRegistrationEnvelope");
  return parsed;
}

/** Parse one snapshot with a shared context so the rejection location can be read back. */
function parseSessionSnapshotWith(value: unknown, context: WireParseContext) {
  const parsed = parseSessionSnapshotEnvelope(value, (state) =>
    parseHunkSessionState(state, child(context, "state")),
  );
  if (parsed === null) reject(context, "parseSessionSnapshotEnvelope");
  return parsed;
}

/** Parse one Hunk session registration payload from the websocket wire format. */
export function parseSessionRegistration(value: unknown): HunkSessionRegistration | null {
  return parseSessionRegistrationWith(value, rootContext());
}

/** Parse one Hunk session snapshot payload from the websocket wire format. */
export function parseSessionSnapshot(value: unknown): HunkSessionSnapshot | null {
  return parseSessionSnapshotWith(value, rootContext());
}

/**
 * Explain why one registration payload is rejected, or return null when it parses.
 *
 * Meant for the daemon's debug log after a rejected registration: the result names the parser
 * and the key path, never the payload, so a version skew is a one-line diagnosis.
 */
export function diagnoseSessionRegistration(value: unknown): SessionWireRejection | null {
  const context = rootContext();
  return parseSessionRegistrationWith(value, context) === null ? context.slot.rejection : null;
}

/** Explain why one snapshot payload is rejected, or return null when it parses. */
export function diagnoseSessionSnapshot(value: unknown): SessionWireRejection | null {
  const context = rootContext();
  return parseSessionSnapshotWith(value, context) === null ? context.slot.rejection : null;
}

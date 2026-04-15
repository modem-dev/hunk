import type { CliInput } from "../core/types";
import {
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
} from "@hunk/session-broker-core";
import type { HunkSessionRegistration, HunkSessionSnapshot } from "./types";
import type {
  HunkSessionInfo,
  HunkSessionState,
  SessionLiveCommentSummary,
  SessionReviewFile,
  SessionReviewHunk,
} from "./types";

const REVIEW_INPUT_KINDS = new Set<CliInput["kind"]>([
  "git",
  "show",
  "stash-show",
  "diff",
  "patch",
  "difftool",
]);

/** Parse one optional diff-side line range tuple when the payload shape matches. */
function parseOptionalRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }

  const start = brokerWireParsers.parsePositiveInt(value[0]);
  const end = brokerWireParsers.parsePositiveInt(value[1]);
  return start !== null && end !== null ? [start, end] : undefined;
}

/** Parse one registered review hunk from the app-owned session payload. */
function parseSessionReviewHunk(value: unknown): SessionReviewHunk | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

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
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const id = brokerWireParsers.parseRequiredString(record.id);
  const path = brokerWireParsers.parseRequiredString(record.path);
  const additions = brokerWireParsers.parseNonNegativeInt(record.additions);
  const deletions = brokerWireParsers.parseNonNegativeInt(record.deletions);
  if (id === null || path === null || additions === null || deletions === null) {
    return null;
  }

  if (!Array.isArray(record.hunks)) {
    return null;
  }

  const hunks = record.hunks.map(parseSessionReviewHunk);
  if (hunks.some((hunk) => hunk === null)) {
    return null;
  }

  return {
    id,
    path,
    previousPath: brokerWireParsers.parseOptionalString(record.previousPath),
    additions,
    deletions,
    hunkCount: (hunks as SessionReviewHunk[]).length,
    patch: brokerWireParsers.parseOptionalString(record.patch),
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
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

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

/** Parse the app-owned registration info embedded inside one broker registration envelope. */
function parseHunkSessionInfo(value: unknown): HunkSessionInfo | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record || !Array.isArray(record.files)) {
    return null;
  }

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

  return {
    inputKind,
    title,
    sourceLabel,
    files: files as SessionReviewFile[],
  };
}

/** Parse the app-owned snapshot state embedded inside one broker snapshot envelope. */
function parseHunkSessionState(value: unknown): HunkSessionState | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record || !Array.isArray(record.liveComments)) {
    return null;
  }

  const selectedHunkIndex = brokerWireParsers.parseNonNegativeInt(record.selectedHunkIndex);
  const showAgentNotes = typeof record.showAgentNotes === "boolean" ? record.showAgentNotes : null;
  if (selectedHunkIndex === null || showAgentNotes === null) {
    return null;
  }

  const liveComments = record.liveComments
    .map(parseSessionLiveCommentSummary)
    .filter((comment): comment is SessionLiveCommentSummary => comment !== null);

  return {
    selectedFileId: brokerWireParsers.parseOptionalString(record.selectedFileId),
    selectedFilePath: brokerWireParsers.parseOptionalString(record.selectedFilePath),
    selectedHunkIndex,
    selectedHunkOldRange: parseOptionalRange(record.selectedHunkOldRange),
    selectedHunkNewRange: parseOptionalRange(record.selectedHunkNewRange),
    showAgentNotes,
    liveCommentCount: liveComments.length,
    liveComments,
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

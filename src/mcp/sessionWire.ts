import type { CliInput } from "../core/types";
import type {
  HunkSessionRegistration,
  HunkSessionSnapshot,
  SessionLiveCommentSummary,
  SessionReviewFile,
  SessionReviewHunk,
  SessionTerminalLocation,
  SessionTerminalMetadata,
} from "./types";

/** Version the live session websocket registration payload separately from the HTTP session API. */
export const HUNK_SESSION_REGISTRATION_VERSION = 1;

const REVIEW_INPUT_KINDS = new Set<CliInput["kind"]>([
  "git",
  "show",
  "stash-show",
  "diff",
  "patch",
  "difftool",
]);

type JsonRecord = Record<string, unknown>;

/** Return one JSON object record when the wire payload is object-shaped. */
function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

/** Parse one required non-empty string field from the websocket payload. */
function parseRequiredString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse one optional string field, dropping malformed values instead of rejecting the payload. */
function parseOptionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse one required non-negative integer field from the websocket payload. */
function parseNonNegativeInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Parse one required positive integer field from the websocket payload. */
function parsePositiveInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Parse one optional diff-side line range tuple when the payload shape matches. */
function parseOptionalRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }

  const start = parsePositiveInt(value[0]);
  const end = parsePositiveInt(value[1]);
  return start !== null && end !== null ? [start, end] : undefined;
}

/** Parse one registered review hunk from the live session websocket payload. */
function parseSessionReviewHunk(value: unknown): SessionReviewHunk | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const index = parseNonNegativeInt(record.index);
  const header = parseRequiredString(record.header);
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

/** Parse one registered review file from the live session websocket payload. */
function parseSessionReviewFile(value: unknown): SessionReviewFile | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = parseRequiredString(record.id);
  const path = parseRequiredString(record.path);
  const additions = parseNonNegativeInt(record.additions);
  const deletions = parseNonNegativeInt(record.deletions);
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
    previousPath: parseOptionalString(record.previousPath),
    additions,
    deletions,
    // Derive the count from the validated hunks so the daemon has one source of truth.
    hunkCount: (hunks as SessionReviewHunk[]).length,
    patch: parseOptionalString(record.patch),
    hunks: hunks as SessionReviewHunk[],
  };
}

/** Parse one terminal location entry, skipping malformed optional metadata. */
function parseSessionTerminalLocation(value: unknown): SessionTerminalLocation | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const source = parseRequiredString(record.source);
  if (source === null) {
    return null;
  }

  return {
    source,
    tty: parseOptionalString(record.tty),
    windowId: parseOptionalString(record.windowId),
    tabId: parseOptionalString(record.tabId),
    paneId: parseOptionalString(record.paneId),
    terminalId: parseOptionalString(record.terminalId),
    sessionId: parseOptionalString(record.sessionId),
  };
}

/** Parse terminal metadata while tolerating malformed optional location detail. */
function parseSessionTerminalMetadata(value: unknown): SessionTerminalMetadata | undefined {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.locations)) {
    return undefined;
  }

  const locations = record.locations
    .map(parseSessionTerminalLocation)
    .filter((location): location is SessionTerminalLocation => location !== null);

  return {
    program: parseOptionalString(record.program),
    locations,
  };
}

/** Parse one review input kind supported by live Hunk sessions. */
function parseReviewInputKind(value: unknown): CliInput["kind"] | null {
  if (typeof value !== "string" || !REVIEW_INPUT_KINDS.has(value as CliInput["kind"])) {
    return null;
  }

  return value as CliInput["kind"];
}

/** Parse one live comment summary from the session snapshot payload. */
function parseSessionLiveCommentSummary(value: unknown): SessionLiveCommentSummary | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const commentId = parseRequiredString(record.commentId);
  const filePath = parseRequiredString(record.filePath);
  const hunkIndex = parseNonNegativeInt(record.hunkIndex);
  const summary = parseRequiredString(record.summary);
  const createdAt = parseRequiredString(record.createdAt);
  const line = parsePositiveInt(record.line);
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
    rationale: parseOptionalString(record.rationale),
    author: parseOptionalString(record.author),
    createdAt,
  };
}

/** Parse one live session registration payload from the websocket wire format. */
export function parseSessionRegistration(value: unknown): HunkSessionRegistration | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const registrationVersion = parsePositiveInt(record.registrationVersion);
  const sessionId = parseRequiredString(record.sessionId);
  const pid = parsePositiveInt(record.pid);
  const cwd = parseRequiredString(record.cwd);
  const inputKind = parseReviewInputKind(record.inputKind);
  const title = parseRequiredString(record.title);
  const sourceLabel = parseRequiredString(record.sourceLabel);
  const launchedAt = parseRequiredString(record.launchedAt);
  if (
    registrationVersion !== HUNK_SESSION_REGISTRATION_VERSION ||
    sessionId === null ||
    pid === null ||
    cwd === null ||
    inputKind === null ||
    title === null ||
    sourceLabel === null ||
    launchedAt === null ||
    !Array.isArray(record.files)
  ) {
    return null;
  }

  const files = record.files.map(parseSessionReviewFile);
  if (files.some((file) => file === null)) {
    return null;
  }

  return {
    registrationVersion,
    sessionId,
    pid,
    cwd,
    repoRoot: parseOptionalString(record.repoRoot),
    inputKind,
    title,
    sourceLabel,
    launchedAt,
    terminal: parseSessionTerminalMetadata(record.terminal),
    files: files as SessionReviewFile[],
  };
}

/** Parse one live session snapshot payload from the websocket wire format. */
export function parseSessionSnapshot(value: unknown): HunkSessionSnapshot | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const selectedHunkIndex = parseNonNegativeInt(record.selectedHunkIndex);
  const showAgentNotes = typeof record.showAgentNotes === "boolean" ? record.showAgentNotes : null;
  const updatedAt = parseRequiredString(record.updatedAt);
  if (selectedHunkIndex === null || showAgentNotes === null || updatedAt === null) {
    return null;
  }

  if (!Array.isArray(record.liveComments)) {
    return null;
  }

  const liveComments = record.liveComments
    .map(parseSessionLiveCommentSummary)
    .filter((comment): comment is SessionLiveCommentSummary => comment !== null);
  return {
    selectedFileId: parseOptionalString(record.selectedFileId),
    selectedFilePath: parseOptionalString(record.selectedFilePath),
    selectedHunkIndex,
    selectedHunkOldRange: parseOptionalRange(record.selectedHunkOldRange),
    selectedHunkNewRange: parseOptionalRange(record.selectedHunkNewRange),
    showAgentNotes,
    // Count only the validated summaries we actually keep so badges and lists stay consistent.
    liveCommentCount: liveComments.length,
    liveComments,
    updatedAt,
  };
}

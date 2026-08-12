import { EXPERIMENTAL_FEATURES, type ExperimentalFeature } from "../../core/experimental";
import type { CliInput } from "../../core/types";
import type { ReviewNoteV1, ReviewResourceDescriptorV1 } from "../../core/review/types";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  MAX_REVIEW_MANIFEST_BYTES,
  MAX_REVIEW_NOTE_BYTES,
  MAX_REVIEW_PRODUCER_METADATA_BYTES,
  MAX_REVIEW_RESOURCE_BYTES,
  MAX_REVIEW_RESOURCE_DESCRIPTORS,
  MAX_REVIEW_SOURCE_RESOURCE_BYTES,
  isReviewSha256Digest,
  type HunkReviewManifestV1,
  type HunkReviewStateV1,
} from "../reviewProtocol";
import {
  MAX_REGISTRATION_FILES,
  MAX_REGISTRATION_HUNKS_PER_FILE,
  MAX_SNAPSHOT_LIVE_COMMENTS,
  MAX_SNAPSHOT_REVIEW_NOTES,
  brokerWireParsers,
  parseGenerationIdentifier,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
  utf8ByteLength,
} from "@hunk/session-broker-core";
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

/** Preserve only recognized experimental feature ids from a session registration. */
function parseExperimentalFeatures(value: unknown): ExperimentalFeature[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value)].filter(
    (feature): feature is ExperimentalFeature =>
      typeof feature === "string" && EXPERIMENTAL_FEATURE_SET.has(feature),
  );
}

/** Parse one optional diff-side line range tuple when the payload shape matches. */
function parseOptionalRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }

  const start = brokerWireParsers.parsePositiveInt(value[0]);
  const end = brokerWireParsers.parsePositiveInt(value[1]);
  return start !== null && end !== null && start <= end ? [start, end] : undefined;
}

/** Parse one exact file-flag projection shared by the manifest and compatibility view. */
function parseReviewFileFlags(
  value: unknown,
): HunkReviewManifestV1["files"][number]["flags"] | null {
  const record = brokerWireParsers.asRecord(value);
  if (
    !record ||
    Object.keys(record).length !== 4 ||
    Object.keys(record).some(
      (key) => !["untracked", "binary", "tooLarge", "partial"].includes(key),
    ) ||
    typeof record.untracked !== "boolean" ||
    typeof record.binary !== "boolean" ||
    typeof record.tooLarge !== "boolean" ||
    typeof record.partial !== "boolean"
  )
    return null;
  return {
    untracked: record.untracked,
    binary: record.binary,
    tooLarge: record.tooLarge,
    partial: record.partial,
  };
}

/** Parse one registered review hunk from the app-owned session payload. */
function parseSessionReviewHunk(value: unknown): SessionReviewHunk | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const index = brokerWireParsers.parseNonNegativeInt(record.index);
  const header = brokerWireParsers.parseRequiredString(record.header);
  const oldRange = parseStrictOptionalRange(record, "oldRange");
  const newRange = parseStrictOptionalRange(record, "newRange");
  if (
    Object.keys(record).some((key) => !["index", "header", "oldRange", "newRange"].includes(key)) ||
    index === null ||
    header === null ||
    !oldRange.valid ||
    !newRange.valid
  ) {
    return null;
  }

  return { index, header, oldRange: oldRange.value, newRange: newRange.value };
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
  const hunkCount = brokerWireParsers.parseNonNegativeInt(record.hunkCount);
  const flags = parseReviewFileFlags(record.flags);
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "id",
          "path",
          "previousPath",
          "additions",
          "deletions",
          "hunkCount",
          "flags",
          "hunks",
        ].includes(key),
    ) ||
    id === null ||
    path === null ||
    additions === null ||
    deletions === null ||
    hunkCount === null ||
    !flags ||
    ("previousPath" in record &&
      brokerWireParsers.parseRequiredString(record.previousPath) === null)
  ) {
    return null;
  }

  if (!Array.isArray(record.hunks) || record.hunks.length > MAX_REGISTRATION_HUNKS_PER_FILE) {
    return null;
  }

  const hunks = record.hunks.map(parseSessionReviewHunk);
  if (hunks.length !== hunkCount || hunks.some((hunk) => hunk === null)) {
    return null;
  }

  // Protocol v1 registrations never carry eager patch bodies; resources are read on demand.
  if (record.patch !== undefined) return null;

  return {
    id,
    path,
    previousPath: brokerWireParsers.parseOptionalString(record.previousPath),
    additions,
    deletions,
    hunkCount,
    flags,
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
    Object.keys(record).some(
      (key) =>
        ![
          "commentId",
          "filePath",
          "hunkIndex",
          "side",
          "line",
          "summary",
          "rationale",
          "author",
          "createdAt",
        ].includes(key),
    ) ||
    ("rationale" in record && typeof record.rationale !== "string") ||
    ("author" in record && typeof record.author !== "string") ||
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
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const noteId = brokerWireParsers.parseRequiredString(record.noteId);
  const filePath = brokerWireParsers.parseRequiredString(record.filePath);
  const body = brokerWireParsers.parseRequiredString(record.body);
  const createdAt = brokerWireParsers.parseRequiredString(record.createdAt);
  const source =
    record.source === "ai" || record.source === "agent" || record.source === "user"
      ? record.source
      : null;
  const hunkIndex =
    "hunkIndex" in record ? brokerWireParsers.parseNonNegativeInt(record.hunkIndex) : undefined;
  const oldRange = parseStrictOptionalRange(record, "oldRange");
  const newRange = parseStrictOptionalRange(record, "newRange");
  const optionalTextKeys = ["title", "author", "updatedAt"] as const;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "noteId",
          "source",
          "filePath",
          "hunkIndex",
          "oldRange",
          "newRange",
          "body",
          "title",
          "author",
          "createdAt",
          "updatedAt",
          "editable",
        ].includes(key),
    ) ||
    optionalTextKeys.some((key) => key in record && typeof record[key] !== "string") ||
    ("hunkIndex" in record && hunkIndex === null) ||
    !oldRange.valid ||
    !newRange.valid ||
    typeof record.editable !== "boolean" ||
    noteId === null ||
    filePath === null ||
    body === null ||
    createdAt === null ||
    source === null
  ) {
    return null;
  }

  return {
    noteId,
    source,
    filePath,
    hunkIndex: hunkIndex ?? undefined,
    oldRange: oldRange.value,
    newRange: newRange.value,
    body,
    title: brokerWireParsers.parseOptionalString(record.title),
    author: brokerWireParsers.parseOptionalString(record.author),
    createdAt,
    updatedAt: brokerWireParsers.parseOptionalString(record.updatedAt),
    editable: record.editable,
  };
}

/** Preserve optional text exactly for lossless review DTOs, including an explicit empty string. */
function parseOptionalReviewText(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

/** Parse an optional range fail-closed when the field is present but malformed. */
function parseStrictOptionalRange(record: Record<string, unknown>, key: string) {
  if (!(key in record)) return { valid: true as const, value: undefined };
  const value = parseOptionalRange(record[key]);
  return value ? { valid: true as const, value } : { valid: false as const, value: undefined };
}

/** Parse one complete bounded review note without dropping optional semantic fields. */
function parseReviewNote(value: unknown): ReviewNoteV1 | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record || utf8ByteLength(JSON.stringify(value)) > MAX_REVIEW_NOTE_BYTES) return null;
  const anchor = brokerWireParsers.asRecord(record.anchor);
  const id = brokerWireParsers.parseRequiredString(record.id);
  const fileKey = brokerWireParsers.parseRequiredString(record.fileKey);
  const summary = typeof record.summary === "string" ? record.summary : null;
  const source =
    record.source === "ai" || record.source === "agent" || record.source === "user"
      ? record.source
      : null;
  const origin =
    record.origin === "sidecar" || record.origin === "live-agent" || record.origin === "user"
      ? record.origin
      : null;
  const optionalTextKeys = [
    "originalSource",
    "rationale",
    "markup",
    "title",
    "author",
    "createdAt",
    "updatedAt",
  ] as const;
  const allowedNoteKeys = new Set([
    "id",
    "source",
    "origin",
    "fileKey",
    "anchor",
    "summary",
    "editable",
    "tags",
    "confidence",
    ...optionalTextKeys,
  ]);
  if (
    !anchor ||
    Object.keys(record).some((key) => !allowedNoteKeys.has(key)) ||
    optionalTextKeys.some((key) => key in record && typeof record[key] !== "string") ||
    !id ||
    !fileKey ||
    summary === null ||
    !source ||
    !origin ||
    !Array.isArray(anchor.intersectingHunkIndices)
  )
    return null;
  const allowedAnchorKeys = new Set([
    "oldRange",
    "newRange",
    "preferred",
    "intersectingHunkIndices",
    "ownerHunkIndex",
  ]);
  const oldRange = parseStrictOptionalRange(anchor, "oldRange");
  const newRange = parseStrictOptionalRange(anchor, "newRange");
  const intersections = anchor.intersectingHunkIndices.map(brokerWireParsers.parseNonNegativeInt);
  if (
    Object.keys(anchor).some((key) => !allowedAnchorKeys.has(key)) ||
    !oldRange.valid ||
    !newRange.valid ||
    intersections.some((entry) => entry === null) ||
    new Set(intersections).size !== intersections.length ||
    ("ownerHunkIndex" in anchor &&
      brokerWireParsers.parseNonNegativeInt(anchor.ownerHunkIndex) === null)
  )
    return null;
  const preferredRecord = brokerWireParsers.asRecord(anchor.preferred);
  const preferredSide =
    preferredRecord?.side === "old" || preferredRecord?.side === "new"
      ? preferredRecord.side
      : null;
  const preferredLine = preferredRecord
    ? brokerWireParsers.parsePositiveInt(preferredRecord.line)
    : null;
  if (
    "preferred" in anchor &&
    (!preferredRecord ||
      Object.keys(preferredRecord).length !== 2 ||
      !("side" in preferredRecord) ||
      !("line" in preferredRecord) ||
      !preferredSide ||
      preferredLine === null)
  )
    return null;
  const tags = !("tags" in record)
    ? undefined
    : Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string")
      ? (record.tags as string[])
      : null;
  if (tags === null || typeof record.editable !== "boolean") return null;
  if (
    "confidence" in record &&
    record.confidence !== "low" &&
    record.confidence !== "medium" &&
    record.confidence !== "high"
  )
    return null;
  return {
    id,
    source,
    origin,
    originalSource: parseOptionalReviewText(record.originalSource),
    fileKey,
    anchor: {
      oldRange: oldRange.value,
      newRange: newRange.value,
      ...(preferredRecord && preferredSide && preferredLine
        ? { preferred: { side: preferredSide, line: preferredLine } }
        : {}),
      intersectingHunkIndices: intersections as number[],
      ownerHunkIndex:
        "ownerHunkIndex" in anchor
          ? (brokerWireParsers.parseNonNegativeInt(anchor.ownerHunkIndex) as number)
          : undefined,
    },
    summary,
    rationale: parseOptionalReviewText(record.rationale),
    markup: parseOptionalReviewText(record.markup),
    title: parseOptionalReviewText(record.title),
    author: parseOptionalReviewText(record.author),
    createdAt: parseOptionalReviewText(record.createdAt),
    updatedAt: parseOptionalReviewText(record.updatedAt),
    editable: record.editable,
    tags: tags ?? undefined,
    confidence: record.confidence as ReviewNoteV1["confidence"],
  };
}

/** Parse one bounded generation resource descriptor. */
function parseReviewResource(value: unknown): ReviewResourceDescriptorV1 | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) return null;
  const id = brokerWireParsers.parseRequiredString(record.id);
  const generation = parseGenerationIdentifier(record.generation);
  const fileKey = brokerWireParsers.parseRequiredString(record.fileKey);
  const kind =
    record.kind === "patch" || record.kind === "source" || record.kind === "canonical-file"
      ? record.kind
      : null;
  const byteLength =
    record.byteLength === undefined
      ? undefined
      : brokerWireParsers.parseNonNegativeInt(record.byteLength);
  if (
    !id ||
    !generation ||
    !fileKey ||
    !kind ||
    byteLength === null ||
    ("byteLength" in record && byteLength === undefined) ||
    (byteLength !== undefined && byteLength > MAX_REVIEW_RESOURCE_BYTES)
  )
    return null;
  const digest = record.digest === undefined ? undefined : record.digest;
  if (digest !== undefined && !isReviewSha256Digest(digest)) return null;
  if (kind === "patch" || kind === "canonical-file") {
    if (
      Object.keys(record).some(
        (key) =>
          !["id", "kind", "generation", "fileKey", "contentType", "byteLength", "digest"].includes(
            key,
          ),
      ) ||
      record.contentType !==
        (kind === "patch"
          ? "text/x-diff; charset=utf-8"
          : "application/vnd.hunk.review-file+json; charset=utf-8") ||
      (byteLength === undefined) !== (digest === undefined) ||
      (kind === "patch" && (byteLength === undefined || !digest))
    )
      return null;
    return kind === "patch"
      ? {
          id,
          kind,
          generation,
          fileKey,
          contentType: "text/x-diff; charset=utf-8",
          byteLength: byteLength!,
          digest: digest!,
        }
      : {
          id,
          kind,
          generation,
          fileKey,
          contentType: "application/vnd.hunk.review-file+json; charset=utf-8",
          ...(byteLength !== undefined ? { byteLength, digest: digest! } : {}),
        };
  }
  const side = record.side === "old" || record.side === "new" ? record.side : null;
  const sourceIdentity = brokerWireParsers.parseRequiredString(record.sourceIdentity);
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "id",
          "kind",
          "generation",
          "fileKey",
          "side",
          "contentType",
          "sourceIdentity",
          "byteLength",
          "digest",
        ].includes(key),
    ) ||
    !side ||
    !sourceIdentity ||
    record.contentType !== "text/plain; charset=utf-8" ||
    (byteLength === undefined) !== (digest === undefined) ||
    (byteLength !== undefined && byteLength > MAX_REVIEW_SOURCE_RESOURCE_BYTES)
  )
    return null;
  return {
    id,
    kind,
    generation,
    fileKey,
    side,
    contentType: record.contentType,
    sourceIdentity,
    byteLength,
    digest,
  };
}

/** Verify note intersections and ownership against one owning file's ordered hunks. */
export function reviewNoteMatchesManifestFile(
  note: ReviewNoteV1,
  file: Pick<HunkReviewManifestV1["files"][number], "key" | "hunks" | "hunkCount">,
) {
  if (note.fileKey !== file.key || file.hunkCount !== file.hunks.length) return false;
  const intersects = (left: readonly [number, number], right?: readonly [number, number]) =>
    right !== undefined && left[0] <= right[1] && right[0] <= left[1];
  const expectedIntersections = file.hunks.flatMap((hunk, index) =>
    (note.anchor.oldRange && intersects(note.anchor.oldRange, hunk.oldRange)) ||
    (note.anchor.newRange && intersects(note.anchor.newRange, hunk.newRange))
      ? [index]
      : [],
  );
  if (
    expectedIntersections.length !== note.anchor.intersectingHunkIndices.length ||
    expectedIntersections.some(
      (index, position) => note.anchor.intersectingHunkIndices[position] !== index,
    )
  )
    return false;
  const preferredOwner = note.anchor.preferred
    ? file.hunks.findIndex((hunk) => {
        const hunkRange = note.anchor.preferred!.side === "old" ? hunk.oldRange : hunk.newRange;
        const noteRange =
          note.anchor.preferred!.side === "old" ? note.anchor.oldRange : note.anchor.newRange;
        return hunkRange
          ? noteRange
            ? intersects(noteRange, hunkRange)
            : note.anchor.preferred!.line >= hunkRange[0] &&
              note.anchor.preferred!.line <= hunkRange[1]
          : false;
      })
    : -1;
  const expectedOwner =
    preferredOwner >= 0
      ? preferredOwner
      : (expectedIntersections[0] ?? (file.hunkCount > 0 ? 0 : undefined));
  return note.anchor.ownerHunkIndex === expectedOwner;
}

/** Parse the bounded review metadata used by future browser adapters. */
function parseReviewManifest(value: unknown): HunkReviewManifestV1 | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record || utf8ByteLength(JSON.stringify(value)) > MAX_REVIEW_MANIFEST_BYTES) return null;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "version",
          "generation",
          "documentIdentity",
          "changesetId",
          "title",
          "sourceLabel",
          "summary",
          "agentSummary",
          "files",
          "resources",
          "capabilities",
        ].includes(key),
    ) ||
    ("summary" in record && typeof record.summary !== "string") ||
    ("agentSummary" in record && typeof record.agentSummary !== "string") ||
    record.version !== HUNK_REVIEW_PROTOCOL_VERSION ||
    !Array.isArray(record.files) ||
    !Array.isArray(record.resources) ||
    record.resources.length > MAX_REVIEW_RESOURCE_DESCRIPTORS
  )
    return null;
  const generation = parseGenerationIdentifier(record.generation);
  const documentIdentity = brokerWireParsers.parseRequiredString(record.documentIdentity);
  const changesetId = brokerWireParsers.parseRequiredString(record.changesetId);
  const title = brokerWireParsers.parseRequiredString(record.title);
  const sourceLabel = brokerWireParsers.parseRequiredString(record.sourceLabel);
  if (
    !generation ||
    !documentIdentity ||
    !changesetId ||
    !title ||
    !sourceLabel ||
    record.files.length > MAX_REGISTRATION_FILES
  )
    return null;
  const resources = record.resources.map(parseReviewResource);
  if (
    resources.some((entry) => !entry) ||
    resources.some((entry) => entry!.generation !== generation) ||
    new Set(resources.map((entry) => entry!.id)).size !== resources.length
  )
    return null;
  const files = record.files.map((value) => {
    const file = brokerWireParsers.asRecord(value);
    if (!file || !Array.isArray(file.hunks) || !Array.isArray(file.notes)) return null;
    const key = brokerWireParsers.parseRequiredString(file.key);
    const runtimeId = brokerWireParsers.parseRequiredString(file.runtimeId);
    const path = brokerWireParsers.parseRequiredString(file.path);
    const changeKind =
      file.changeKind === "change" ||
      file.changeKind === "rename-pure" ||
      file.changeKind === "rename-changed" ||
      file.changeKind === "new" ||
      file.changeKind === "deleted"
        ? file.changeKind
        : null;
    const language = brokerWireParsers.parseOptionalString(file.language);
    const agentSummary = brokerWireParsers.parseOptionalString(file.agentSummary);
    const additions = brokerWireParsers.parseNonNegativeInt(file.additions);
    const deletions = brokerWireParsers.parseNonNegativeInt(file.deletions);
    const statsTruncated = typeof file.statsTruncated === "boolean" ? file.statsTruncated : null;
    const hunkCount = brokerWireParsers.parseNonNegativeInt(file.hunkCount);
    const flags = parseReviewFileFlags(file.flags);
    const patchResourceId = brokerWireParsers.parseRequiredString(file.patchResourceId);
    const canonicalResourceId = brokerWireParsers.parseRequiredString(file.canonicalResourceId);
    const sourceIds = brokerWireParsers.asRecord(file.sourceResourceIds);
    const hunks = file.hunks.map(parseSessionReviewHunk);
    const notes = file.notes.map(parseReviewNote);
    if (
      Object.keys(file).some(
        (field) =>
          ![
            "key",
            "runtimeId",
            "path",
            "previousPath",
            "changeKind",
            "language",
            "agentSummary",
            "additions",
            "deletions",
            "statsTruncated",
            "hunkCount",
            "hasTrailingContext",
            "flags",
            "patchResourceId",
            "canonicalResourceId",
            "sourceResourceIds",
            "hunks",
            "notes",
          ].includes(field),
      ) ||
      !key ||
      !runtimeId ||
      !path ||
      !changeKind ||
      ("language" in file && typeof file.language !== "string") ||
      ("agentSummary" in file && typeof file.agentSummary !== "string") ||
      additions === null ||
      deletions === null ||
      statsTruncated === null ||
      hunkCount === null ||
      hunkCount !== hunks.length ||
      (file.hasTrailingContext !== undefined && typeof file.hasTrailingContext !== "boolean") ||
      !flags ||
      !patchResourceId ||
      !canonicalResourceId ||
      !sourceIds ||
      Object.keys(sourceIds).some((side) => side !== "old" && side !== "new") ||
      ("old" in sourceIds && brokerWireParsers.parseRequiredString(sourceIds.old) === null) ||
      ("new" in sourceIds && brokerWireParsers.parseRequiredString(sourceIds.new) === null) ||
      ("previousPath" in file &&
        brokerWireParsers.parseRequiredString(file.previousPath) === null) ||
      hunks.some((entry, index) => !entry || entry.index !== index) ||
      notes.some((entry) => !entry)
    )
      return null;
    return {
      key,
      runtimeId,
      path,
      previousPath: brokerWireParsers.parseOptionalString(file.previousPath),
      changeKind,
      language,
      agentSummary,
      additions,
      deletions,
      statsTruncated,
      hunkCount,
      ...(typeof file.hasTrailingContext === "boolean"
        ? { hasTrailingContext: file.hasTrailingContext }
        : {}),
      flags,
      patchResourceId,
      canonicalResourceId,
      sourceResourceIds: {
        old: brokerWireParsers.parseOptionalString(sourceIds.old),
        new: brokerWireParsers.parseOptionalString(sourceIds.new),
      },
      hunks: hunks as SessionReviewHunk[],
      notes: notes as ReviewNoteV1[],
    };
  });
  if (files.some((entry) => !entry)) return null;
  const parsedFiles = files as HunkReviewManifestV1["files"];
  if (
    new Set(parsedFiles.map((file) => file.key)).size !== parsedFiles.length ||
    new Set(parsedFiles.map((file) => file.runtimeId)).size !== parsedFiles.length
  )
    return null;
  const noteIds = parsedFiles.flatMap((file) => file.notes.map((note) => note.id));
  if (
    new Set(noteIds).size !== noteIds.length ||
    parsedFiles.some((file) =>
      file.notes.some((note) => !reviewNoteMatchesManifestFile(note, file)),
    )
  )
    return null;
  const capabilities = brokerWireParsers.asRecord(record.capabilities);
  const actions = capabilities?.actions;
  if (
    !capabilities ||
    Object.keys(capabilities).some((key) => !["actions", "canReload"].includes(key)) ||
    (capabilities.canReload !== undefined && typeof capabilities.canReload !== "boolean") ||
    !Array.isArray(actions) ||
    !actions.every((action) =>
      [
        "selection/select",
        "selection/set-line",
        "filter/set",
        "notes/set-visibility",
        "notes/create-user",
        "notes/update-user",
        "notes/remove-user",
        "notes/remove-live",
        "expansion/toggle",
        "session/reload",
        "trust/decide",
      ].includes(String(action)),
    )
  )
    return null;
  return {
    version: HUNK_REVIEW_PROTOCOL_VERSION,
    generation,
    documentIdentity,
    changesetId,
    title,
    sourceLabel,
    summary: brokerWireParsers.parseOptionalString(record.summary),
    agentSummary: brokerWireParsers.parseOptionalString(record.agentSummary),
    files: parsedFiles,
    resources: resources as ReviewResourceDescriptorV1[],
    capabilities: {
      actions: actions as HunkReviewManifestV1["capabilities"]["actions"],
      ...(typeof capabilities.canReload === "boolean" ? { canReload: capabilities.canReload } : {}),
    },
  };
}

/** Parse the app-owned registration info embedded inside one broker registration envelope. */
function parseHunkSessionInfo(value: unknown): HunkSessionInfo | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record || !Array.isArray(record.files) || record.files.length > MAX_REGISTRATION_FILES) {
    return null;
  }

  if (
    Object.keys(record).some(
      (key) =>
        ![
          "inputKind",
          "title",
          "sourceLabel",
          "experimentalFeatures",
          "browserReviewCapabilityHash",
          "documentGeneration",
          "reviewManifest",
          "files",
        ].includes(key),
    )
  )
    return null;

  const inputKind = parseReviewInputKind(record.inputKind);
  const title = brokerWireParsers.parseRequiredString(record.title);
  const sourceLabel = brokerWireParsers.parseRequiredString(record.sourceLabel);
  const documentGeneration = parseGenerationIdentifier(record.documentGeneration);
  const browserReviewCapabilityHash =
    record.browserReviewCapabilityHash === undefined
      ? undefined
      : typeof record.browserReviewCapabilityHash === "string" &&
          /^[a-f\d]{64}$/.test(record.browserReviewCapabilityHash)
        ? record.browserReviewCapabilityHash
        : null;
  const reviewManifest = parseReviewManifest(record.reviewManifest);
  if (
    inputKind === null ||
    title === null ||
    sourceLabel === null ||
    !documentGeneration ||
    browserReviewCapabilityHash === null ||
    !reviewManifest ||
    reviewManifest.generation !== documentGeneration ||
    title !== reviewManifest.title ||
    sourceLabel !== reviewManifest.sourceLabel
  ) {
    return null;
  }

  const files = record.files.map(parseSessionReviewFile);
  if (files.some((file) => file === null) || files.length !== reviewManifest.files.length) {
    return null;
  }
  const resourcesById = new Map(
    reviewManifest.resources.map((resource) => [resource.id, resource]),
  );
  const referencedResourceIds = new Set<string>();
  for (let index = 0; index < reviewManifest.files.length; index += 1) {
    const manifestFile = reviewManifest.files[index]!;
    const legacyFile = files[index]!;
    const patch = resourcesById.get(manifestFile.patchResourceId);
    const canonical = resourcesById.get(manifestFile.canonicalResourceId);
    if (
      legacyFile.id !== manifestFile.runtimeId ||
      legacyFile.path !== manifestFile.path ||
      legacyFile.previousPath !== manifestFile.previousPath ||
      legacyFile.additions !== manifestFile.additions ||
      legacyFile.deletions !== manifestFile.deletions ||
      legacyFile.hunkCount !== manifestFile.hunkCount ||
      JSON.stringify(legacyFile.flags) !== JSON.stringify(manifestFile.flags) ||
      JSON.stringify(legacyFile.hunks) !== JSON.stringify(manifestFile.hunks) ||
      patch?.kind !== "patch" ||
      patch.fileKey !== manifestFile.key ||
      canonical?.kind !== "canonical-file" ||
      canonical.fileKey !== manifestFile.key ||
      manifestFile.notes.some((note) => note.fileKey !== manifestFile.key)
    ) {
      return null;
    }
    referencedResourceIds.add(manifestFile.patchResourceId);
    referencedResourceIds.add(manifestFile.canonicalResourceId);
    for (const side of ["old", "new"] as const) {
      const resourceId = manifestFile.sourceResourceIds[side];
      if (!resourceId) continue;
      const source = resourcesById.get(resourceId);
      if (source?.kind !== "source" || source.fileKey !== manifestFile.key || source.side !== side)
        return null;
      referencedResourceIds.add(resourceId);
    }
  }
  if (
    referencedResourceIds.size !== reviewManifest.resources.length ||
    reviewManifest.resources.some((resource) => !referencedResourceIds.has(resource.id))
  )
    return null;

  return {
    inputKind,
    title,
    sourceLabel,
    experimentalFeatures: parseExperimentalFeatures(record.experimentalFeatures),
    ...(browserReviewCapabilityHash !== undefined ? { browserReviewCapabilityHash } : {}),
    documentGeneration,
    reviewManifest,
    files: files as SessionReviewFile[],
  };
}

/** Parse the bounded semantic state projection paired with a manifest generation. */
function parseReviewState(value: unknown): HunkReviewStateV1 | null {
  const record = brokerWireParsers.asRecord(value);
  const selection = brokerWireParsers.asRecord(record?.selection);
  if (
    !record ||
    Object.keys(record).some(
      (key) =>
        ![
          "documentGeneration",
          "stateRevision",
          "selection",
          "reveal",
          "filter",
          "showAgentNotes",
          "trustPromptRepoRoot",
          "notes",
          "expandedGaps",
          "sourceStatusByFileKey",
        ].includes(key),
    ) ||
    !selection ||
    !Array.isArray(record.notes) ||
    record.notes.length > MAX_SNAPSHOT_REVIEW_NOTES ||
    (record.expandedGaps !== undefined && !Array.isArray(record.expandedGaps)) ||
    (record.reveal !== undefined && !brokerWireParsers.asRecord(record.reveal)) ||
    (record.sourceStatusByFileKey !== undefined &&
      !brokerWireParsers.asRecord(record.sourceStatusByFileKey))
  )
    return null;
  const documentGeneration = parseGenerationIdentifier(record.documentGeneration);
  const stateRevision = brokerWireParsers.parseNonNegativeInt(record.stateRevision);
  const fileKey =
    selection.fileKey === null ? null : brokerWireParsers.parseRequiredString(selection.fileKey);
  const hunkIndex = brokerWireParsers.parseNonNegativeInt(selection.hunkIndex);
  const filter = typeof record.filter === "string" ? record.filter : null;
  const showAgentNotes = typeof record.showAgentNotes === "boolean" ? record.showAgentNotes : null;
  const notes = record.notes.map(parseReviewNote);
  const reveal = (record.reveal ?? {
    token: 0,
    fileTopToken: 0,
    hunkToken: 0,
    lineToken: 0,
    kind: "hunk",
    scrollToNote: false,
  }) as Record<string, unknown>;
  const revealKind =
    reveal.kind === "hunk" || reveal.kind === "file-top" || reveal.kind === "line"
      ? reveal.kind
      : undefined;
  const revealToken = brokerWireParsers.parseNonNegativeInt(reveal.token);
  const fileTopToken = brokerWireParsers.parseNonNegativeInt(reveal.fileTopToken);
  const hunkToken = brokerWireParsers.parseNonNegativeInt(reveal.hunkToken);
  const lineToken = brokerWireParsers.parseNonNegativeInt(reveal.lineToken);
  const rawExpandedGaps = (record.expandedGaps ?? []) as unknown[];
  const expandedGaps = rawExpandedGaps.flatMap((value) => {
    const gap = brokerWireParsers.asRecord(value);
    const oldRange = parseOptionalRange(gap?.oldRange);
    const newRange = parseOptionalRange(gap?.newRange);
    return gap &&
      typeof gap.fileKey === "string" &&
      typeof gap.gapId === "string" &&
      (gap.side === "old" || gap.side === "new") &&
      oldRange &&
      newRange &&
      typeof gap.sourceIdentity === "string" &&
      typeof gap.expanded === "boolean" &&
      Object.keys(gap).every((key) =>
        ["fileKey", "gapId", "side", "oldRange", "newRange", "sourceIdentity", "expanded"].includes(
          key,
        ),
      )
      ? [{ ...gap, oldRange, newRange }]
      : [];
  });
  const sourceStatusByFileKey: HunkReviewStateV1["sourceStatusByFileKey"] = {};
  let sourceStatusesValid = true;
  for (const [key, value] of Object.entries(
    (record.sourceStatusByFileKey ?? {}) as Record<string, unknown>,
  )) {
    const status = brokerWireParsers.asRecord(value);
    if (
      !status ||
      !["idle", "loading", "loaded", "error"].includes(String(status.kind)) ||
      (status.reason !== undefined && status.reason !== "too-large") ||
      Object.keys(status).some((field) => !["kind", "reason"].includes(field))
    ) {
      sourceStatusesValid = false;
      break;
    }
    sourceStatusByFileKey[key] = status as NonNullable<
      HunkReviewStateV1["sourceStatusByFileKey"]
    >[string];
  }
  const side = selection.side === "old" || selection.side === "new" ? selection.side : undefined;
  const line =
    selection.line === undefined ? undefined : brokerWireParsers.parsePositiveInt(selection.line);
  if (
    !documentGeneration ||
    stateRevision === null ||
    (fileKey === null && selection.fileKey !== null) ||
    hunkIndex === null ||
    filter === null ||
    showAgentNotes === null ||
    (record.trustPromptRepoRoot !== undefined &&
      brokerWireParsers.parseRequiredString(record.trustPromptRepoRoot) === null) ||
    revealToken === null ||
    fileTopToken === null ||
    hunkToken === null ||
    lineToken === null ||
    revealKind === undefined ||
    typeof reveal.scrollToNote !== "boolean" ||
    Object.keys(reveal).some(
      (key) =>
        !["token", "fileTopToken", "hunkToken", "lineToken", "kind", "scrollToNote"].includes(key),
    ) ||
    expandedGaps.length !== rawExpandedGaps.length ||
    !sourceStatusesValid ||
    notes.some((entry) => !entry) ||
    new Set((notes as ReviewNoteV1[]).map((note) => note.id)).size !== notes.length ||
    ("side" in selection && side === undefined) ||
    ("line" in selection && line === undefined) ||
    ("contextDigest" in selection && typeof selection.contextDigest !== "string") ||
    Object.keys(selection).some(
      (key) => !["fileKey", "hunkIndex", "side", "line", "contextDigest"].includes(key),
    ) ||
    line === null
  )
    return null;
  return {
    documentGeneration,
    stateRevision,
    selection: {
      fileKey,
      hunkIndex,
      side,
      line,
      contextDigest: "contextDigest" in selection ? (selection.contextDigest as string) : undefined,
    },
    reveal: {
      token: revealToken,
      fileTopToken,
      hunkToken,
      lineToken,
      kind: revealKind,
      scrollToNote: reveal.scrollToNote as boolean,
    },
    filter,
    showAgentNotes,
    ...(typeof record.trustPromptRepoRoot === "string"
      ? { trustPromptRepoRoot: record.trustPromptRepoRoot }
      : {}),
    notes: notes as ReviewNoteV1[],
    expandedGaps: expandedGaps as unknown as HunkReviewStateV1["expandedGaps"],
    sourceStatusByFileKey,
  };
}

/** Parse the app-owned snapshot state embedded inside one broker snapshot envelope. */
function parseHunkSessionState(value: unknown): HunkSessionState | null {
  const record = brokerWireParsers.asRecord(value);
  if (
    !record ||
    Object.keys(record).some(
      (key) =>
        ![
          "documentGeneration",
          "stateRevision",
          "review",
          "selectedFileId",
          "selectedFilePath",
          "selectedHunkIndex",
          "selectedHunkOldRange",
          "selectedHunkNewRange",
          "showAgentNotes",
          "noteMarkupWidth",
          "liveCommentCount",
          "liveComments",
          "reviewNoteCount",
          "reviewNotes",
        ].includes(key),
    ) ||
    utf8ByteLength(JSON.stringify(value)) > MAX_REVIEW_PRODUCER_METADATA_BYTES ||
    !Array.isArray(record.liveComments) ||
    !Array.isArray(record.reviewNotes) ||
    record.liveComments.length > MAX_SNAPSHOT_LIVE_COMMENTS ||
    record.reviewNotes.length > MAX_SNAPSHOT_REVIEW_NOTES
  ) {
    return null;
  }

  const documentGeneration = parseGenerationIdentifier(record.documentGeneration);
  const stateRevision = brokerWireParsers.parseNonNegativeInt(record.stateRevision);
  const review = parseReviewState(record.review);
  const selectedHunkIndex = brokerWireParsers.parseNonNegativeInt(record.selectedHunkIndex);
  const showAgentNotes = typeof record.showAgentNotes === "boolean" ? record.showAgentNotes : null;
  const liveCommentCount = brokerWireParsers.parseNonNegativeInt(record.liveCommentCount);
  const reviewNoteCount = brokerWireParsers.parseNonNegativeInt(record.reviewNoteCount);
  const selectedFileId =
    "selectedFileId" in record
      ? brokerWireParsers.parseRequiredString(record.selectedFileId)
      : undefined;
  const selectedFilePath =
    "selectedFilePath" in record
      ? brokerWireParsers.parseRequiredString(record.selectedFilePath)
      : undefined;
  const oldRange = parseStrictOptionalRange(record, "selectedHunkOldRange");
  const newRange = parseStrictOptionalRange(record, "selectedHunkNewRange");
  const noteMarkupWidth =
    "noteMarkupWidth" in record
      ? brokerWireParsers.parseNonNegativeInt(record.noteMarkupWidth)
      : undefined;
  if (
    !documentGeneration ||
    stateRevision === null ||
    !review ||
    review.documentGeneration !== documentGeneration ||
    review.stateRevision !== stateRevision ||
    selectedHunkIndex === null ||
    showAgentNotes === null ||
    showAgentNotes !== review.showAgentNotes ||
    liveCommentCount === null ||
    reviewNoteCount === null ||
    ("selectedFileId" in record && selectedFileId === null) ||
    ("selectedFilePath" in record && selectedFilePath === null) ||
    !oldRange.valid ||
    !newRange.valid ||
    ("noteMarkupWidth" in record && noteMarkupWidth === null)
  ) {
    return null;
  }

  const liveComments = record.liveComments.map(parseSessionLiveCommentSummary);
  const reviewNotes = record.reviewNotes.map(parseSessionReviewNoteSummary);
  if (
    liveComments.some((comment) => comment === null) ||
    reviewNotes.some((note) => note === null) ||
    liveCommentCount !== liveComments.length ||
    reviewNoteCount !== reviewNotes.length
  )
    return null;

  return {
    documentGeneration,
    stateRevision,
    review,
    selectedFileId: selectedFileId ?? undefined,
    selectedFilePath: selectedFilePath ?? undefined,
    selectedHunkIndex,
    selectedHunkOldRange: oldRange.value,
    selectedHunkNewRange: newRange.value,
    showAgentNotes,
    noteMarkupWidth: noteMarkupWidth ?? undefined,
    liveCommentCount,
    liveComments: liveComments as SessionLiveCommentSummary[],
    reviewNoteCount,
    reviewNotes: reviewNotes as SessionReviewNoteSummary[],
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

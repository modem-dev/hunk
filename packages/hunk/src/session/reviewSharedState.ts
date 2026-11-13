/**
 * The shared-state snapshot: everything about a live review that every attached surface shares.
 *
 * A publication says where a review is and which resources it offers; this says what the
 * review *contains* beyond its files — the notes, the filter, note-layer visibility, viewed
 * files, agent attention marks, the latest agent reveal request — plus the file index a sidebar and
 * header need, and the presentation defaults a new surface starts from. Selection is
 * deliberately absent: it is per surface (`docs/browser-review-seam-audit.md`, G2), and a
 * browser resolves its own.
 *
 * How a client uses it:
 *
 * - The SSE `publication` event and `GET /review-api/<session>/publication` carry
 *   `sharedStateRevision`. It advances only when this snapshot's content would differ, so a
 *   selection moving in the terminal advances the publication's `stateRevision` but not
 *   this. A client fetches `GET /review-api/<session>/state` when `sharedStateRevision`
 *   moves within a generation, or when the generation changes.
 * - The state body names the `(generation, stateRevision)` it was materialized at and its
 *   `sharedStateRevision`. Within one generation a body with a higher `sharedStateRevision`
 *   supersedes a lower one; across generations, order by `classifyReviewPublication` on the
 *   address. A stale request is answered with the current state, never an error.
 * - `agentReveal.token` increases every time an agent asks every surface to show something
 *   (`hunk session navigate`, a comment or mark added with `--focus`). A surface reveals the
 *   target when the token changes, and never because a person moved their own selection.
 *
 * Bounds: the whole serialized snapshot is at most `MAX_REVIEW_SHARED_STATE_BYTES` (the
 * protocol's envelope bound); a larger one is refused with `state-too-large`. Each note obeys
 * the shared note-size check. The producer materializes the snapshot once per
 * `sharedStateRevision` and the daemon reads it through the same chunked, digest-verified
 * resource path as file content, addressed by `reviewSharedStateResourceId`.
 *
 * Browser-safe by construction: it imports from `core/review/` and the other browser-safe
 * session modules only (`scripts/quality/source-boundaries.test.ts`).
 */
import { parseReviewGeneration } from "../core/review/generationOrder";
import { reviewNoteWithinSizeLimit } from "../core/review/noteSize";
import type {
  ReviewFileChangeKind,
  ReviewFileFlagsV1,
  ReviewFileStatsV1,
  ReviewLineRange,
  ReviewNoteV1,
  ReviewRangeAnchorV1,
  ReviewSide,
} from "../core/review/types";
import { asRecord, hasExactKeys, utf8ByteLength } from "../core/review/validation";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  hunkReviewKeysWith as keysWith,
  isHunkReviewIdentifier as isIdentifier,
  isHunkReviewIndex as isIndex,
  isHunkReviewLineNumber as isLineNumber,
  isHunkReviewSide as isSide,
  MAX_HUNK_REVIEW_ENVELOPE_BYTES,
  MAX_HUNK_REVIEW_FILTER_BYTES,
} from "./reviewProtocol";

/** Largest serialized shared-state snapshot any surface serves: the protocol envelope bound. */
export const MAX_REVIEW_SHARED_STATE_BYTES = MAX_HUNK_REVIEW_ENVELOPE_BYTES;

/** Content type the snapshot is served and read as. */
export const REVIEW_SHARED_STATE_CONTENT_TYPE = "application/json; charset=utf-8" as const;

/** Resource id the producer serves one materialized snapshot under, per shared revision. */
export function reviewSharedStateResourceId(sharedStateRevision: number) {
  return `state:${sharedStateRevision}`;
}

/**
 * Resource id a reader asks for when it does not know the current shared revision.
 *
 * The producer answers its first chunk under the concrete `state:<revision>` id, and the
 * reader assembles the rest under that id, so a whole snapshot is always one revision.
 */
export const REVIEW_SHARED_STATE_CURRENT_RESOURCE_ID = "state:current";

/**
 * Read a snapshot resource id: its shared revision, `"current"` for the alias, or nothing when
 * the id names no snapshot.
 */
export function parseReviewSharedStateResourceId(value: unknown): number | "current" | undefined {
  if (value === REVIEW_SHARED_STATE_CURRENT_RESOURCE_ID) return "current";
  if (typeof value !== "string") return undefined;
  const match = /^state:(0|[1-9][0-9]{0,15})$/.exec(value);
  const revision = match ? Number(match[1]) : undefined;
  return revision !== undefined && Number.isSafeInteger(revision) ? revision : undefined;
}

// -- File index -----------------------------------------------------------------------

/** One file as a sidebar and file header need it, without its hunks or line text. */
export interface ReviewSharedFileV1 {
  key: string;
  path: string;
  previousPath?: string;
  changeKind: ReviewFileChangeKind;
  language?: string;
  stats: ReviewFileStatsV1;
  flags: ReviewFileFlagsV1;
  splitLineCount: number;
  unifiedLineCount: number;
  contentIdentity: string;
  agentSummary?: string;
  /**
   * Present when the agent-context sidecar names this file, even with no summary and no
   * annotations: such a file is a stop in the annotated-file scope, as in the terminal.
   */
  agentContext?: true;
}

// -- Notes ----------------------------------------------------------------------------

/** Where one shared note came from. */
export type ReviewSharedNoteOriginV1 =
  /** Added by an agent during the review (`hunk session comment`). */
  | "live"
  /** Written by the reviewer. */
  | "user"
  /** Loaded with the changeset from an agent-context sidecar; never editable. */
  | "sidecar";

/** One renderable note: the shared model plus whether its context moved since it was written. */
export interface ReviewSharedNoteV1 {
  note: ReviewNoteV1;
  /** `stale` stays visible at its last known anchor; orphaned notes are never listed. */
  resolution: "active" | "stale";
  origin: ReviewSharedNoteOriginV1;
}

// -- Agent highlights and reveal --------------------------------------------------------

/** Tones an attention mark is painted in; the extension line-highlight vocabulary. */
export type ReviewAgentHighlightToneV1 = "match" | "current" | "info" | "warning" | "error" | "dim";

const AGENT_HIGHLIGHT_TONES: readonly ReviewAgentHighlightToneV1[] = [
  "match",
  "current",
  "info",
  "warning",
  "error",
  "dim",
];

/** One agent attention mark: a `[start, end)` character range on one diff line. */
export interface ReviewAgentHighlightV1 {
  side: ReviewSide;
  line: number;
  start: number;
  end: number;
  tone: ReviewAgentHighlightToneV1;
}

/** What an agent last asked every surface to show. */
export interface ReviewAgentRevealV1 {
  /** Strictly increasing within one session; reveal when it changes. */
  token: number;
  fileKey: string;
  hunkIndex: number;
  /** Present when the agent named an exact line. */
  side?: ReviewSide;
  line?: number;
  /** Present when the reveal targets one note (a comment added with `--focus`). */
  noteId?: string;
}

// -- Presentation defaults (G1, E2) ----------------------------------------------------

/** Every theme token is a color string; `tokens` maps Hunk's semantic token names to them. */
export type ReviewThemeTokensV1 = Record<string, string>;

/**
 * The theme a session resolved at launch.
 *
 * A built-in theme is named by id, which a client maps to its own copy of the palette. A
 * custom or extension theme exists only in the session, so it travels as its resolved tokens.
 */
export type ReviewThemeDefaultsV1 =
  | { kind: "builtin"; id: string; appearance: "light" | "dark" }
  | {
      kind: "custom";
      id: string;
      label: string;
      appearance: "light" | "dark";
      /** Semantic surface and text colors, e.g. `background`, `addedBg`, `noteBorder`. */
      tokens: ReviewThemeTokensV1;
      /** Fallback syntax colors by role, e.g. `keyword`, `string`, `comment`. */
      syntaxColors: ReviewThemeTokensV1;
      /** Base Shiki theme name, when the custom theme layers on one. */
      syntaxTheme?: string;
      /** Exact TextMate scope colors layered onto the base syntax theme. */
      syntaxScopeOverrides?: ReviewThemeTokensV1;
      /** Drop the base theme's scope rules so only the overrides color code. */
      syntaxScopesReplaceBase?: boolean;
    };

/** View options a surface starts from; each surface may override them locally (G1). */
export interface ReviewViewDefaultsV1 {
  layout: "auto" | "split" | "unified";
  wrapLines: boolean;
  lineNumbers: boolean;
  hunkHeaders: boolean;
}

/** Where a new surface starts: what the host's config chain resolved. */
export interface ReviewPresentationDefaultsV1 {
  title: string;
  sourceLabel: string;
  theme: ReviewThemeDefaultsV1;
  view: ReviewViewDefaultsV1;
  /** Built-in review command id to the chords it answers to, after `[keybindings]`. */
  keymap: Record<string, string[]>;
}

// -- The snapshot ---------------------------------------------------------------------

/** One live review's shared state at one `(generation, stateRevision)`. */
export interface ReviewSharedStateV1 {
  protocolVersion: typeof HUNK_REVIEW_PROTOCOL_VERSION;
  generation: string;
  stateRevision: number;
  sharedStateRevision: number;
  /** Document order, which is review and sidebar order. */
  files: ReviewSharedFileV1[];
  /** Per file in document order: sidecar annotations, then stored notes in thread order. */
  notes: ReviewSharedNoteV1[];
  filter: string;
  showAgentNotes: boolean;
  /**
   * Files the reviewer marked viewed, by file key, with the content identity each was marked
   * at. Only marks matching the file's current `contentIdentity` are listed.
   */
  viewedFiles: Record<string, { contentIdentity: string }>;
  /** Agent attention marks by file key; files without marks are absent. */
  agentHighlights: Record<string, ReviewAgentHighlightV1[]>;
  agentReveal: ReviewAgentRevealV1 | null;
  presentation: ReviewPresentationDefaultsV1;
  /**
   * Sidecar annotations left out of `notes` because the launch sidecar exceeded the projected
   * sidecar bounds (`MAX_PROJECTED_SIDECAR_NOTES`, `MAX_PROJECTED_SIDECAR_NOTE_BYTES`); the
   * terminal still shows them. Absent when nothing was omitted. A client says so visibly.
   */
  omittedSidecarNotes?: number;
}

// -- Parsing --------------------------------------------------------------------------

const NOTE_SOURCES = ["ai", "agent", "user"] as const;
const CHANGE_KINDS: readonly ReviewFileChangeKind[] = [
  "change",
  "rename-pure",
  "rename-changed",
  "new",
  "deleted",
];

/** Whether one optional value is absent or a string. */
function optionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

/** Whether one value is an inclusive 1-based line range. */
function isLineRange(value: unknown): value is ReviewLineRange {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isLineNumber(value[0]) &&
    isLineNumber(value[1]) &&
    value[0] <= value[1]
  );
}

/** Whether one value is a string-to-string map. */
function isStringRecord(value: unknown): value is Record<string, string> {
  const record = asRecord(value);
  return Boolean(record) && Object.values(record!).every((entry) => typeof entry === "string");
}

/** Validate one resolved note anchor without re-deriving its placement. */
function isAnchor(value: unknown): value is ReviewRangeAnchorV1 {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      keysWith(["intersectingHunkIndices"], {
        oldRange: record.oldRange,
        newRange: record.newRange,
        preferred: record.preferred,
        ownerHunkIndex: record.ownerHunkIndex,
      }),
    )
  ) {
    return false;
  }
  const preferred = record.preferred === undefined ? undefined : asRecord(record.preferred);
  return (
    Array.isArray(record.intersectingHunkIndices) &&
    record.intersectingHunkIndices.every(isIndex) &&
    (record.oldRange === undefined || isLineRange(record.oldRange)) &&
    (record.newRange === undefined || isLineRange(record.newRange)) &&
    (record.ownerHunkIndex === undefined || isIndex(record.ownerHunkIndex)) &&
    (record.preferred === undefined ||
      (preferred !== undefined &&
        hasExactKeys(preferred, ["side", "line"]) &&
        isSide(preferred.side) &&
        isLineNumber(preferred.line)))
  );
}

/** Validate one shared note: the note model's fields, then the shared size bound. */
function isSharedNote(value: unknown): value is ReviewSharedNoteV1 {
  const record = asRecord(value);
  if (!record || !hasExactKeys(record, ["note", "resolution", "origin"])) return false;
  if (record.resolution !== "active" && record.resolution !== "stale") return false;
  if (record.origin !== "live" && record.origin !== "user" && record.origin !== "sidecar") {
    return false;
  }
  const note = asRecord(record.note);
  if (!note) return false;
  const optional = [
    "parentId",
    "originalSource",
    "rationale",
    "markup",
    "title",
    "author",
    "createdAt",
    "updatedAt",
    "tags",
    "confidence",
  ];
  const allowed = [
    "id",
    "source",
    "fileKey",
    "anchor",
    "summary",
    "editable",
    ...optional.filter((key) => note[key] !== undefined),
  ];
  return (
    hasExactKeys(note, allowed) &&
    isIdentifier(note.id) &&
    (note.parentId === undefined || isIdentifier(note.parentId)) &&
    NOTE_SOURCES.includes(note.source as (typeof NOTE_SOURCES)[number]) &&
    isIdentifier(note.fileKey) &&
    isAnchor(note.anchor) &&
    typeof note.summary === "string" &&
    typeof note.editable === "boolean" &&
    optionalString(note.originalSource) &&
    optionalString(note.rationale) &&
    optionalString(note.markup) &&
    optionalString(note.title) &&
    optionalString(note.author) &&
    optionalString(note.createdAt) &&
    optionalString(note.updatedAt) &&
    (note.tags === undefined ||
      (Array.isArray(note.tags) && note.tags.every((tag) => typeof tag === "string"))) &&
    (note.confidence === undefined ||
      note.confidence === "low" ||
      note.confidence === "medium" ||
      note.confidence === "high") &&
    reviewNoteWithinSizeLimit(note as unknown as ReviewNoteV1)
  );
}

/** Validate one file-index entry. */
function isSharedFile(value: unknown): value is ReviewSharedFileV1 {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      keysWith(
        [
          "key",
          "path",
          "changeKind",
          "stats",
          "flags",
          "splitLineCount",
          "unifiedLineCount",
          "contentIdentity",
        ],
        {
          previousPath: record.previousPath,
          language: record.language,
          agentSummary: record.agentSummary,
          agentContext: record.agentContext,
        },
      ),
    )
  ) {
    return false;
  }
  const stats = asRecord(record.stats);
  const flags = asRecord(record.flags);
  return (
    isIdentifier(record.key) &&
    typeof record.path === "string" &&
    optionalString(record.previousPath) &&
    optionalString(record.language) &&
    optionalString(record.agentSummary) &&
    (record.agentContext === undefined || record.agentContext === true) &&
    CHANGE_KINDS.includes(record.changeKind as ReviewFileChangeKind) &&
    stats !== undefined &&
    hasExactKeys(stats, ["additions", "deletions", "truncated"]) &&
    isIndex(stats.additions) &&
    isIndex(stats.deletions) &&
    typeof stats.truncated === "boolean" &&
    flags !== undefined &&
    hasExactKeys(flags, ["untracked", "binary", "tooLarge", "partial"]) &&
    Object.values(flags).every((flag) => typeof flag === "boolean") &&
    isIndex(record.splitLineCount) &&
    isIndex(record.unifiedLineCount) &&
    isIdentifier(record.contentIdentity)
  );
}

/** Validate one attention mark. */
function isAgentHighlight(value: unknown): value is ReviewAgentHighlightV1 {
  const record = asRecord(value);
  return (
    record !== undefined &&
    hasExactKeys(record, ["side", "line", "start", "end", "tone"]) &&
    isSide(record.side) &&
    isLineNumber(record.line) &&
    isIndex(record.start) &&
    isIndex(record.end) &&
    (record.end as number) > (record.start as number) &&
    AGENT_HIGHLIGHT_TONES.includes(record.tone as ReviewAgentHighlightToneV1)
  );
}

/** Validate the agent reveal request, or its absence. */
function isAgentReveal(value: unknown): value is ReviewAgentRevealV1 | null {
  if (value === null) return true;
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      keysWith(["token", "fileKey", "hunkIndex"], {
        side: record.side,
        line: record.line,
        noteId: record.noteId,
      }),
    )
  ) {
    return false;
  }
  return (
    isIndex(record.token) &&
    (record.token as number) > 0 &&
    isIdentifier(record.fileKey) &&
    isIndex(record.hunkIndex) &&
    (record.side === undefined) === (record.line === undefined) &&
    (record.side === undefined || isSide(record.side)) &&
    (record.line === undefined || isLineNumber(record.line)) &&
    (record.noteId === undefined || isIdentifier(record.noteId))
  );
}

/** Validate the presentation defaults block. */
function isPresentation(value: unknown): value is ReviewPresentationDefaultsV1 {
  const record = asRecord(value);
  if (!record || !hasExactKeys(record, ["title", "sourceLabel", "theme", "view", "keymap"])) {
    return false;
  }
  const view = asRecord(record.view);
  const keymap = asRecord(record.keymap);
  const theme = asRecord(record.theme);
  const appearanceOk = theme?.appearance === "light" || theme?.appearance === "dark";
  const themeOk =
    theme !== undefined &&
    appearanceOk &&
    isIdentifier(theme.id) &&
    ((theme.kind === "builtin" && hasExactKeys(theme, ["kind", "id", "appearance"])) ||
      (theme.kind === "custom" &&
        hasExactKeys(
          theme,
          keysWith(["kind", "id", "label", "appearance", "tokens", "syntaxColors"], {
            syntaxTheme: theme.syntaxTheme,
            syntaxScopeOverrides: theme.syntaxScopeOverrides,
            syntaxScopesReplaceBase: theme.syntaxScopesReplaceBase,
          }),
        ) &&
        typeof theme.label === "string" &&
        isStringRecord(theme.tokens) &&
        isStringRecord(theme.syntaxColors) &&
        optionalString(theme.syntaxTheme) &&
        (theme.syntaxScopeOverrides === undefined || isStringRecord(theme.syntaxScopeOverrides)) &&
        (theme.syntaxScopesReplaceBase === undefined ||
          typeof theme.syntaxScopesReplaceBase === "boolean")));
  return (
    typeof record.title === "string" &&
    typeof record.sourceLabel === "string" &&
    themeOk &&
    view !== undefined &&
    hasExactKeys(view, ["layout", "wrapLines", "lineNumbers", "hunkHeaders"]) &&
    (view.layout === "auto" || view.layout === "split" || view.layout === "unified") &&
    typeof view.wrapLines === "boolean" &&
    typeof view.lineNumbers === "boolean" &&
    typeof view.hunkHeaders === "boolean" &&
    keymap !== undefined &&
    Object.entries(keymap).every(
      ([commandId, chords]) =>
        isIdentifier(commandId) &&
        Array.isArray(chords) &&
        chords.every((chord) => typeof chord === "string"),
    )
  );
}

/**
 * Parse one shared-state snapshot strictly: exact keys at every level, every note within the
 * shared size bound, and note and highlight file keys present in the file index.
 */
export function parseReviewSharedState(value: unknown): ReviewSharedStateV1 | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(
      record,
      keysWith(
        [
          "protocolVersion",
          "generation",
          "stateRevision",
          "sharedStateRevision",
          "files",
          "notes",
          "filter",
          "showAgentNotes",
          "viewedFiles",
          "agentHighlights",
          "agentReveal",
          "presentation",
        ],
        { omittedSidecarNotes: record.omittedSidecarNotes },
      ),
    ) ||
    (record.omittedSidecarNotes !== undefined &&
      !(isIndex(record.omittedSidecarNotes) && record.omittedSidecarNotes > 0)) ||
    record.protocolVersion !== HUNK_REVIEW_PROTOCOL_VERSION ||
    parseReviewGeneration(record.generation) === undefined ||
    !isIndex(record.stateRevision) ||
    !isIndex(record.sharedStateRevision) ||
    !Array.isArray(record.files) ||
    !record.files.every(isSharedFile) ||
    !Array.isArray(record.notes) ||
    !record.notes.every(isSharedNote) ||
    typeof record.filter !== "string" ||
    utf8ByteLength(record.filter) > MAX_HUNK_REVIEW_FILTER_BYTES ||
    typeof record.showAgentNotes !== "boolean" ||
    !isAgentReveal(record.agentReveal) ||
    !isPresentation(record.presentation)
  ) {
    return undefined;
  }

  const fileKeys = new Set((record.files as ReviewSharedFileV1[]).map((file) => file.key));
  if (fileKeys.size !== record.files.length) return undefined;
  if (!(record.notes as ReviewSharedNoteV1[]).every((entry) => fileKeys.has(entry.note.fileKey))) {
    return undefined;
  }
  const identityByKey = new Map(
    (record.files as ReviewSharedFileV1[]).map((file) => [file.key, file.contentIdentity] as const),
  );
  const viewed = asRecord(record.viewedFiles);
  if (
    !viewed ||
    !Object.entries(viewed).every(([fileKey, mark]) => {
      const entry = asRecord(mark);
      return (
        entry !== undefined &&
        hasExactKeys(entry, ["contentIdentity"]) &&
        entry.contentIdentity === identityByKey.get(fileKey)
      );
    })
  ) {
    return undefined;
  }
  const highlights = asRecord(record.agentHighlights);
  if (
    !highlights ||
    !Object.entries(highlights).every(
      ([fileKey, marks]) =>
        fileKeys.has(fileKey) &&
        Array.isArray(marks) &&
        marks.length > 0 &&
        marks.every(isAgentHighlight),
    )
  ) {
    return undefined;
  }
  return record as unknown as ReviewSharedStateV1;
}

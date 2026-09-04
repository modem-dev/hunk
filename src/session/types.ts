import type { ExperimentalFeature } from "../core/run/experimental";
import type {
  ExtensionLineHighlightTone,
  ExtensionReviewDescriptor,
  SessionReloadReason,
} from "../extension-api/types";
import type { CommentTargetInput, DiffSide } from "../core/liveComments";
import type { ReviewPublicationAddress } from "../core/review/generationOrder";
import type { CliInput, ReviewNoteSource } from "../core/run/commandInputs";
import type {
  HunkReviewActionEnvelopeV1,
  HunkReviewResourceCatalogV1,
  HunkReviewResourceReadEnvelopeV1,
  HunkReviewResultV1,
} from "./reviewProtocol";
import type {
  SessionRegistration,
  SessionServerMessage,
  SessionSnapshot,
  SessionTargetInput,
  SessionTerminalMetadata,
} from "@hunk/session-broker-core";

export type { CommentTargetInput, DiffSide, LiveComment } from "../core/liveComments";

export interface SessionFileSummary {
  id: string;
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
  hunkCount: number;
}

export interface SessionReviewHunk {
  index: number;
  header: string;
  oldRange?: [number, number];
  newRange?: [number, number];
}

export interface SessionReviewFile extends SessionFileSummary {
  /**
   * Raw unified diff text, present only where it has been resolved.
   *
   * A live session no longer embeds it in its registration: patch text is served as a
   * review resource, read in bounded verified chunks on demand, so the daemon holds one
   * copy of one patch at a time instead of every patch of every session at once. It is
   * still parsed here because a session from an older build still sends it, and because
   * the field is where reconstructed text lands before `hunk session review
   * --include-patch` renders it.
   */
  patch?: string;
  hunks: SessionReviewHunk[];
}

export interface SelectedHunkSummary {
  index: number;
  oldRange?: [number, number];
  newRange?: [number, number];
}

/** App-owned registration data that the broker carries without interpreting. */
export interface HunkSessionInfo {
  inputKind: CliInput["kind"];
  title: string;
  sourceLabel: string;
  experimentalFeatures?: ExperimentalFeature[];
  /** Provider-neutral metadata attached by the CLI extension that delegated this review. */
  review?: ExtensionReviewDescriptor;
  files: SessionReviewFile[];
  /**
   * The generation this registration projects, and every resource it offers.
   *
   * Absent from a session built before review resources existed; the broker's mirror
   * treats that as "this session serves no resources" rather than as an invalid payload.
   */
  reviewCatalog?: HunkReviewResourceCatalogV1;
  /**
   * Digest of the capability this session's review may be read under.
   *
   * The digest, never the capability: the session keeps the secret and the daemon only
   * ever compares hashes, so nothing the daemon holds can be replayed as authorization.
   * Absent from a session that predates the HTTP review surface, which then simply has no
   * review to serve over HTTP.
   */
  reviewCapabilityDigest?: string;
}

/** App-owned live state that the broker snapshots and rebroadcasts. */
export interface HunkSessionState {
  selectedFileId?: string;
  selectedFilePath?: string;
  selectedHunkIndex: number;
  selectedHunkOldRange?: [number, number];
  selectedHunkNewRange?: [number, number];
  showAgentNotes: boolean;
  /** Width STML note markup renders at in the session's current layout ("new"-side anchor). */
  noteMarkupWidth?: number;
  liveCommentCount: number;
  liveComments: SessionLiveCommentSummary[];
  reviewNoteCount?: number;
  reviewNotes?: SessionReviewNoteSummary[];
  /**
   * Where the session's review currently sits in its producer's sequence.
   *
   * The one fact the broker's review mirror orders on, classified through
   * `classifyReviewPublication` rather than compared by a local rule. Absent from a
   * session built before the mirror existed.
   */
  reviewPublication?: ReviewPublicationAddress;
}

export type HunkSessionRegistration = SessionRegistration<HunkSessionInfo>;
export type HunkSessionSnapshot = SessionSnapshot<HunkSessionState>;

export interface CommentToolInput extends SessionTargetInput, CommentTargetInput {
  reveal?: boolean;
}

export interface CommentBatchItemInput extends CommentTargetInput {}

export interface CommentBatchToolInput extends SessionTargetInput {
  comments: CommentBatchItemInput[];
  revealMode?: "none" | "first";
}

export interface NavigateToHunkToolInput extends SessionTargetInput {
  filePath?: string;
  hunkIndex?: number;
  side?: DiffSide;
  line?: number;
  commentDirection?: "next" | "prev";
}

export interface ReloadSessionToolInput extends SessionTargetInput {
  nextInput: CliInput;
  sourcePath?: string;
}

export interface RemoveCommentToolInput extends SessionTargetInput {
  commentId: string;
}

export interface ClearCommentsToolInput extends SessionTargetInput {
  filePath?: string;
  includeUser?: boolean;
}

/** One bounded resource read, brokered to the session that published the generation. */
export interface ReadReviewResourceToolInput
  extends SessionTargetInput, HunkReviewResourceReadEnvelopeV1 {}

/** One semantic review action, brokered to the producer that owns the review state. */
export interface ApplyReviewActionToolInput
  extends SessionTargetInput, HunkReviewActionEnvelopeV1 {}

/** One agent-set attention mark: a character range inside one diff line. */
export interface HighlightToolInput extends SessionTargetInput {
  filePath: string;
  side: DiffSide;
  line: number;
  /** `[start, end)` UTF-16 code-unit offsets into the line's raw source text. */
  start: number;
  end: number;
  tone?: ExtensionLineHighlightTone;
  /** Also land the viewport on the marked line. */
  reveal?: boolean;
}

export interface ClearHighlightsToolInput extends SessionTargetInput {
  filePath?: string;
}

export interface SessionLiveCommentSummary {
  commentId: string;
  filePath: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
  summary: string;
  rationale?: string;
  author?: string;
  createdAt: string;
}

export interface SessionReviewNoteSummary {
  noteId: string;
  parentId?: string;
  source: ReviewNoteSource;
  filePath: string;
  hunkIndex?: number;
  oldRange?: [number, number];
  newRange?: [number, number];
  body: string;
  title?: string;
  author?: string;
  createdAt: string;
  updatedAt?: string;
  editable: boolean;
}

export interface AppliedCommentResult {
  commentId: string;
  fileId: string;
  filePath: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
  /** Width the comment's STML markup was validated at, present when markup was given. */
  markupWidth?: number;
  /** STML render notes for the comment's markup, present only when non-empty. */
  markupNotes?: string[];
}

export interface AppliedCommentBatchResult {
  applied: AppliedCommentResult[];
}

export interface NavigatedSelectionResult {
  fileId: string;
  filePath: string;
  hunkIndex: number;
  selectedHunk?: SelectedHunkSummary;
  /** For line targets: whether the viewport landed on the exact line or fell back to its hunk. */
  revealed?: "line" | "hunk";
  side?: DiffSide;
  line?: number;
}

export interface AppliedHighlightResult {
  fileId: string;
  filePath: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
  start: number;
  end: number;
  tone: ExtensionLineHighlightTone;
  /** Agent marks now active on this file, including this one. */
  fileMarkCount: number;
  /** Where the optional `reveal` landed. */
  revealed?: "line" | "hunk";
}

export interface ClearedHighlightsResult {
  removedCount: number;
  remainingCount: number;
  filePath?: string;
}

export interface RemovedCommentResult {
  commentId: string;
  removed: boolean;
  remainingCommentCount: number;
  source?: ReviewNoteSource;
}

export interface ClearedCommentsResult {
  removedCount: number;
  remainingCommentCount: number;
  filePath?: string;
  includeUser?: boolean;
  removedLiveCommentCount?: number;
  removedUserNoteCount?: number;
  remainingLiveCommentCount?: number;
  remainingUserNoteCount?: number;
}

/** Options one session reload accepts, shared by the host, the UI, and the daemon bridge. */
export interface ReloadSessionOptions {
  /** False keeps the mounted App and its in-memory review state. */
  resetApp?: boolean;
  sourcePath?: string;
  /** What triggered the reload; forwarded to extension `session_reload` handlers. */
  reason?: SessionReloadReason;
  /**
   * Re-run extension discovery and loading before reloading content, so repo
   * extensions trusted mid-session take effect without restarting Hunk.
   */
  reloadExtensions?: boolean;
}

export interface ReloadedSessionResult {
  sessionId: string;
  inputKind: CliInput["kind"];
  title: string;
  sourceLabel: string;
  fileCount: number;
  selectedFilePath?: string;
  selectedHunkIndex: number;
}

export interface ListedSession {
  sessionId: string;
  pid: number;
  cwd: string;
  repoRoot?: string;
  launchedAt: string;
  terminal?: SessionTerminalMetadata;
  inputKind: CliInput["kind"];
  title: string;
  sourceLabel: string;
  experimentalFeatures?: ExperimentalFeature[];
  review?: ExtensionReviewDescriptor;
  fileCount: number;
  files: SessionFileSummary[];
  snapshot: HunkSessionSnapshot;
}

export interface SelectedSessionContext {
  sessionId: string;
  title: string;
  sourceLabel: string;
  cwd?: string;
  repoRoot?: string;
  inputKind: CliInput["kind"];
  experimentalFeatures?: ExperimentalFeature[];
  review?: ExtensionReviewDescriptor;
  selectedFile: SessionFileSummary | null;
  selectedHunk: SelectedHunkSummary | null;
  showAgentNotes: boolean;
  /** Width STML note markup renders at in the session's current layout. */
  noteMarkupWidth?: number;
  liveCommentCount: number;
}

export interface SessionReview {
  sessionId: string;
  title: string;
  sourceLabel: string;
  cwd?: string;
  repoRoot?: string;
  inputKind: CliInput["kind"];
  experimentalFeatures?: ExperimentalFeature[];
  review?: ExtensionReviewDescriptor;
  selectedFile: SessionReviewFile | null;
  selectedHunk: SessionReviewHunk | null;
  showAgentNotes: boolean;
  liveCommentCount: number;
  reviewNoteCount?: number;
  reviewNotes?: SessionReviewNoteSummary[];
  files: SessionReviewFile[];
}

export type HunkSessionCommandResult =
  | AppliedCommentResult
  | AppliedCommentBatchResult
  | NavigatedSelectionResult
  | RemovedCommentResult
  | ClearedCommentsResult
  | ReloadedSessionResult
  | HunkReviewResultV1
  | AppliedHighlightResult
  | ClearedHighlightsResult;

export type HunkSessionServerMessage =
  | SessionServerMessage<"comment", CommentToolInput>
  | SessionServerMessage<"comment_batch", CommentBatchToolInput>
  | SessionServerMessage<"navigate_to_hunk", NavigateToHunkToolInput>
  | SessionServerMessage<"reload_session", ReloadSessionToolInput>
  | SessionServerMessage<"remove_comment", RemoveCommentToolInput>
  | SessionServerMessage<"clear_comments", ClearCommentsToolInput>
  | SessionServerMessage<"read_review_resource", ReadReviewResourceToolInput>
  | SessionServerMessage<"apply_review_action", ApplyReviewActionToolInput>
  | SessionServerMessage<"highlight", HighlightToolInput>
  | SessionServerMessage<"clear_highlights", ClearHighlightsToolInput>;

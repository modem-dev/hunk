import type { ExperimentalFeature } from "../core/experimental";
import type { CommentTargetInput, DiffSide } from "../core/liveComments";
import type { CliInput, ReviewNoteSource } from "../core/types";
import type { SessionBrokerClient } from "../session-broker/brokerClient";
import type {
  SessionClientMessage,
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
  files: SessionReviewFile[];
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

export interface ListCommentsToolInput extends SessionTargetInput {
  filePath?: string;
}

export interface RemoveCommentToolInput extends SessionTargetInput {
  commentId: string;
}

export interface ClearCommentsToolInput extends SessionTargetInput {
  filePath?: string;
  includeUser?: boolean;
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
  | ReloadedSessionResult;

export type HunkSessionClientMessage = SessionClientMessage<
  HunkSessionInfo,
  HunkSessionState,
  HunkSessionCommandResult
>;

export type HunkSessionBrokerClient = SessionBrokerClient<
  HunkSessionInfo,
  HunkSessionState,
  HunkSessionServerMessage,
  HunkSessionCommandResult
>;

export type HunkSessionServerMessage =
  | SessionServerMessage<"comment", CommentToolInput>
  | SessionServerMessage<"comment_batch", CommentBatchToolInput>
  | SessionServerMessage<"navigate_to_hunk", NavigateToHunkToolInput>
  | SessionServerMessage<"reload_session", ReloadSessionToolInput>
  | SessionServerMessage<"remove_comment", RemoveCommentToolInput>
  | SessionServerMessage<"clear_comments", ClearCommentsToolInput>;

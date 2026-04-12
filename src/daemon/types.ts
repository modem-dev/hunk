import type { AgentAnnotation, CliInput } from "../core/types";

export type DiffSide = "old" | "new";

export interface SessionTargetInput {
  sessionId?: string;
  sessionPath?: string;
  repoRoot?: string;
}

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

export interface SessionTerminalLocation {
  source: string;
  tty?: string;
  windowId?: string;
  tabId?: string;
  paneId?: string;
  terminalId?: string;
  sessionId?: string;
}

export interface SessionTerminalMetadata {
  program?: string;
  locations: SessionTerminalLocation[];
}

export interface HunkSessionRegistration {
  registrationVersion: number;
  sessionId: string;
  pid: number;
  cwd: string;
  repoRoot?: string;
  inputKind: CliInput["kind"];
  title: string;
  sourceLabel: string;
  launchedAt: string;
  terminal?: SessionTerminalMetadata;
  files: SessionReviewFile[];
}

export interface HunkSessionSnapshot {
  selectedFileId?: string;
  selectedFilePath?: string;
  selectedHunkIndex: number;
  selectedHunkOldRange?: [number, number];
  selectedHunkNewRange?: [number, number];
  showAgentNotes: boolean;
  liveCommentCount: number;
  liveComments: SessionLiveCommentSummary[];
  updatedAt: string;
}

export interface CommentTargetInput {
  filePath: string;
  hunkIndex?: number;
  side?: DiffSide;
  line?: number;
  summary: string;
  rationale?: string;
  author?: string;
}

export interface CommentToolInput extends SessionTargetInput, CommentTargetInput {
  reveal?: boolean;
}

export interface CommentBatchItemInput extends CommentTargetInput {}

export interface CommentBatchToolInput extends SessionTargetInput {
  comments: CommentBatchItemInput[];
  revealMode?: "none" | "first";
}

export interface NavigateToFileToolInput extends SessionTargetInput {
  filePath: string;
  hunkIndex?: number;
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

export interface LiveComment extends AgentAnnotation {
  id: string;
  source: "mcp";
  author?: string;
  createdAt: string;
  filePath: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
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

export interface AppliedCommentResult {
  commentId: string;
  fileId: string;
  filePath: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
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
}

export interface ClearedCommentsResult {
  removedCount: number;
  remainingCommentCount: number;
  filePath?: string;
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

export interface ListedSessionFile extends SessionFileSummary {
  selected: boolean;
}

export interface SelectedSessionContext {
  sessionId: string;
  title: string;
  sourceLabel: string;
  cwd?: string;
  repoRoot?: string;
  inputKind: CliInput["kind"];
  selectedFile: SessionFileSummary | null;
  selectedHunk: SelectedHunkSummary | null;
  showAgentNotes: boolean;
  liveCommentCount: number;
}

export interface SessionReview {
  sessionId: string;
  title: string;
  sourceLabel: string;
  cwd?: string;
  repoRoot?: string;
  inputKind: CliInput["kind"];
  selectedFile: SessionReviewFile | null;
  selectedHunk: SessionReviewHunk | null;
  showAgentNotes: boolean;
  liveCommentCount: number;
  files: SessionReviewFile[];
}

export type SessionCommandResult =
  | AppliedCommentResult
  | AppliedCommentBatchResult
  | NavigatedSelectionResult
  | RemovedCommentResult
  | ClearedCommentsResult
  | ReloadedSessionResult;

export type SessionClientMessage =
  | {
      type: "register";
      registration: HunkSessionRegistration;
      snapshot: HunkSessionSnapshot;
    }
  | {
      type: "snapshot";
      sessionId: string;
      snapshot: HunkSessionSnapshot;
    }
  | {
      type: "heartbeat";
      sessionId: string;
    }
  | {
      type: "command-result";
      requestId: string;
      ok: true;
      result: SessionCommandResult;
    }
  | {
      type: "command-result";
      requestId: string;
      ok: false;
      error: string;
    };

export interface ListCommentsToolInput extends SessionTargetInput {
  filePath?: string;
}

export interface RemoveCommentToolInput extends SessionTargetInput {
  commentId: string;
}

export interface ClearCommentsToolInput extends SessionTargetInput {
  filePath?: string;
}

export type SessionServerMessage =
  | {
      type: "command";
      requestId: string;
      command: "comment";
      input: CommentToolInput;
    }
  | {
      type: "command";
      requestId: string;
      command: "comment_batch";
      input: CommentBatchToolInput;
    }
  | {
      type: "command";
      requestId: string;
      command: "navigate_to_hunk";
      input: NavigateToHunkToolInput;
    }
  | {
      type: "command";
      requestId: string;
      command: "reload_session";
      input: ReloadSessionToolInput;
    }
  | {
      type: "command";
      requestId: string;
      command: "remove_comment";
      input: RemoveCommentToolInput;
    }
  | {
      type: "command";
      requestId: string;
      command: "clear_comments";
      input: ClearCommentsToolInput;
    };

export interface ListedSession {
  sessionId: string;
  pid: number;
  cwd: string;
  repoRoot?: string;
  inputKind: CliInput["kind"];
  title: string;
  sourceLabel: string;
  launchedAt: string;
  terminal?: SessionTerminalMetadata;
  fileCount: number;
  files: SessionFileSummary[];
  snapshot: HunkSessionSnapshot;
}

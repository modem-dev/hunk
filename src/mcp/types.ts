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

export interface SelectedHunkSummary {
  index: number;
  oldRange?: [number, number];
  newRange?: [number, number];
}

export interface HunkSessionRegistration {
  sessionId: string;
  pid: number;
  cwd: string;
  repoRoot?: string;
  inputKind: CliInput["kind"];
  title: string;
  sourceLabel: string;
  launchedAt: string;
  files: SessionFileSummary[];
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

export interface CommentToolInput extends SessionTargetInput {
  filePath: string;
  side: DiffSide;
  line: number;
  summary: string;
  rationale?: string;
  reveal?: boolean;
  author?: string;
}

export interface NavigateToFileToolInput extends SessionTargetInput {
  filePath: string;
  hunkIndex?: number;
}

export interface NavigateToHunkToolInput extends SessionTargetInput {
  filePath: string;
  hunkIndex?: number;
  side?: DiffSide;
  line?: number;
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

export type SessionCommandResult =
  | AppliedCommentResult
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
  fileCount: number;
  files: SessionFileSummary[];
  snapshot: HunkSessionSnapshot;
}

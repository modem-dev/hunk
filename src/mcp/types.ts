import type { AgentAnnotation, CliInput } from "../core/types";

export type DiffSide = "old" | "new";

export interface SessionFileSummary {
  id: string;
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
  hunkCount: number;
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
  showAgentNotes: boolean;
  liveCommentCount: number;
  updatedAt: string;
}

export interface CommentToolInput {
  sessionId?: string;
  repoRoot?: string;
  filePath: string;
  side: DiffSide;
  line: number;
  summary: string;
  rationale?: string;
  reveal?: boolean;
  author?: string;
}

export interface LiveComment extends AgentAnnotation {
  id: string;
  source: "mcp";
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
      type: "command-result";
      requestId: string;
      ok: true;
      result: AppliedCommentResult;
    }
  | {
      type: "command-result";
      requestId: string;
      ok: false;
      error: string;
    };

export type SessionServerMessage = {
  type: "command";
  requestId: string;
  command: "comment";
  input: CommentToolInput;
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

import type {
  SessionCommentAddCommandInput,
  SessionCommentClearCommandInput,
  SessionCommentListCommandInput,
  SessionCommentRemoveCommandInput,
  SessionNavigateCommandInput,
  SessionReloadCommandInput,
  SessionSelectorInput,
} from "../core/types";
import type {
  AppliedCommentResult,
  ClearedCommentsResult,
  ListedSession,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
  SelectedSessionContext,
  SessionLiveCommentSummary,
} from "../mcp/types";

export const HUNK_SESSION_API_PATH = "/session-api";
export const HUNK_SESSION_CAPABILITIES_PATH = `${HUNK_SESSION_API_PATH}/capabilities`;
export const HUNK_SESSION_API_VERSION = 1;

export type SessionDaemonAction =
  | "list"
  | "get"
  | "context"
  | "navigate"
  | "reload"
  | "comment-add"
  | "comment-list"
  | "comment-rm"
  | "comment-clear";

export interface SessionDaemonCapabilities {
  version: number;
  actions: SessionDaemonAction[];
}

export type SessionDaemonRequest =
  | {
      action: "list";
    }
  | {
      action: "get";
      selector: SessionSelectorInput;
    }
  | {
      action: "context";
      selector: SessionSelectorInput;
    }
  | {
      action: "navigate";
      selector: SessionNavigateCommandInput["selector"];
      filePath: string;
      hunkNumber?: number;
      side?: "old" | "new";
      line?: number;
    }
  | {
      action: "reload";
      selector: SessionReloadCommandInput["selector"];
      nextInput: SessionReloadCommandInput["nextInput"];
      sourcePath?: string;
    }
  | {
      action: "comment-add";
      selector: SessionCommentAddCommandInput["selector"];
      filePath: string;
      side: "old" | "new";
      line: number;
      summary: string;
      rationale?: string;
      author?: string;
      reveal: boolean;
    }
  | {
      action: "comment-list";
      selector: SessionCommentListCommandInput["selector"];
      filePath?: string;
    }
  | {
      action: "comment-rm";
      selector: SessionCommentRemoveCommandInput["selector"];
      commentId: string;
    }
  | {
      action: "comment-clear";
      selector: SessionCommentClearCommandInput["selector"];
      filePath?: string;
    };

export type SessionDaemonResponse =
  | { sessions: ListedSession[] }
  | { session: ListedSession }
  | { context: SelectedSessionContext }
  | { result: NavigatedSelectionResult }
  | { result: ReloadedSessionResult }
  | { result: AppliedCommentResult }
  | { comments: SessionLiveCommentSummary[] }
  | { result: RemovedCommentResult }
  | { result: ClearedCommentsResult };

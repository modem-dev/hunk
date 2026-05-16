import type {
  SessionCommentAddCommandInput,
  SessionCommentApplyCommandInput,
  SessionCommentClearCommandInput,
  SessionCommentListCommandInput,
  SessionCommentRemoveCommandInput,
  SessionNavigateCommandInput,
  SessionNoteGetCommandInput,
  SessionNoteListCommandInput,
  SessionNoteRemoveCommandInput,
  SessionReloadCommandInput,
  SessionReviewCommandInput,
  SessionSelectorInput,
} from "../core/types";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  ListedSession,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
  RemovedUserNoteResult,
  SelectedSessionContext,
  SessionLiveCommentSummary,
  SessionReview,
  SessionReviewNoteSummary,
} from "../hunk-session/types";

export const HUNK_SESSION_API_PATH = "/session-api";
export const HUNK_SESSION_CAPABILITIES_PATH = `${HUNK_SESSION_API_PATH}/capabilities`;
export const HUNK_SESSION_API_VERSION = 1;

/**
 * Version daemon/session compatibility separately from the HTTP action surface so newer Hunk
 * builds can refresh an older daemon even when it still exposes the same API endpoints.
 */
export const HUNK_SESSION_DAEMON_VERSION = 3;

export type SessionDaemonAction =
  | "list"
  | "get"
  | "context"
  | "review"
  | "navigate"
  | "reload"
  | "comment-add"
  | "comment-apply"
  | "comment-list"
  | "comment-rm"
  | "comment-clear"
  | "note-list"
  | "note-get"
  | "note-rm";

export interface SessionDaemonCapabilities {
  version: number;
  daemonVersion: number;
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
      action: "review";
      selector: SessionSelectorInput;
      includePatch: SessionReviewCommandInput["includePatch"];
      includeNotes: SessionReviewCommandInput["includeNotes"];
    }
  | {
      action: "navigate";
      selector: SessionNavigateCommandInput["selector"];
      filePath?: string;
      hunkNumber?: number;
      side?: "old" | "new";
      line?: number;
      commentDirection?: "next" | "prev";
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
      action: "comment-apply";
      selector: SessionCommentApplyCommandInput["selector"];
      comments: SessionCommentApplyCommandInput["comments"];
      revealMode: SessionCommentApplyCommandInput["revealMode"];
    }
  | {
      action: "comment-list";
      selector: SessionCommentListCommandInput["selector"];
      filePath?: string;
      type?: SessionCommentListCommandInput["type"];
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
    }
  | {
      action: "note-list";
      selector: SessionNoteListCommandInput["selector"];
      filePath?: string;
      source?: SessionNoteListCommandInput["source"];
    }
  | {
      action: "note-get";
      selector: SessionNoteGetCommandInput["selector"];
      noteId: string;
    }
  | {
      action: "note-rm";
      selector: SessionNoteRemoveCommandInput["selector"];
      noteId: string;
    };

export type SessionDaemonResponse =
  | { sessions: ListedSession[] }
  | { session: ListedSession }
  | { context: SelectedSessionContext }
  | { review: SessionReview }
  | { result: NavigatedSelectionResult }
  | { result: ReloadedSessionResult }
  | { result: AppliedCommentResult }
  | { result: AppliedCommentBatchResult }
  | { comments: Array<SessionLiveCommentSummary | SessionReviewNoteSummary> }
  | { notes: SessionReviewNoteSummary[] }
  | { note: SessionReviewNoteSummary }
  | { result: RemovedCommentResult }
  | { result: RemovedUserNoteResult }
  | { result: ClearedCommentsResult };

import type {
  SessionCommentAddCommandInput,
  SessionCommentApplyCommandInput,
  SessionCommentClearCommandInput,
  SessionCommentListCommandInput,
  SessionCommentRemoveCommandInput,
  SessionHighlightAddCommandInput,
  SessionHighlightClearCommandInput,
  SessionNavigateCommandInput,
  SessionReloadCommandInput,
  SessionReviewCommandInput,
  SessionSelectorInput,
} from "../core/run/commandInputs";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  AppliedHighlightResult,
  ClearedCommentsResult,
  ClearedHighlightsResult,
  ListedSession,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
  SelectedSessionContext,
  SessionLiveCommentSummary,
  SessionReview,
  SessionReviewNoteSummary,
} from "./types";

export const HUNK_SESSION_API_PATH = "/session-api";
export const HUNK_SESSION_CAPABILITIES_PATH = `${HUNK_SESSION_API_PATH}/capabilities`;
export const HUNK_SESSION_API_VERSION = 1;

/**
 * Version daemon/session compatibility separately from the HTTP action surface so newer Hunk
 * builds can refresh an older daemon even when it still exposes the same API endpoints. Bump this
 * when daemon-forwarded payloads change, even if the supported action names stay stable.
 */
export const HUNK_SESSION_DAEMON_VERSION = 13;

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
  | "highlight-add"
  | "highlight-clear";

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
      includePatch?: SessionReviewCommandInput["includePatch"];
      includeNotes?: SessionReviewCommandInput["includeNotes"];
    }
  | {
      action: "navigate";
      selector: SessionNavigateCommandInput["selector"];
      filePath?: string;
      hunkNumber?: number;
      side?: "old" | "new";
      line?: number;
      commentDirection?: "next" | "prev";
      commentId?: string;
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
      markup?: string;
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
      includeUser?: boolean;
    }
  | {
      action: "highlight-add";
      selector: SessionHighlightAddCommandInput["selector"];
      filePath: string;
      side: "old" | "new";
      line: number;
      start: number;
      end: number;
      tone?: "match" | "current" | "info" | "warning" | "error" | "dim";
      reveal: boolean;
    }
  | {
      action: "highlight-clear";
      selector: SessionHighlightClearCommandInput["selector"];
      filePath?: string;
    };

export interface SessionDaemonResponses {
  list: { sessions: ListedSession[] };
  get: { session: ListedSession };
  context: { context: SelectedSessionContext };
  review: { review: SessionReview };
  navigate: { result: NavigatedSelectionResult };
  reload: { result: ReloadedSessionResult };
  "comment-add": { result: AppliedCommentResult };
  "comment-apply": { result: AppliedCommentBatchResult };
  "comment-list": { comments: Array<SessionLiveCommentSummary | SessionReviewNoteSummary> };
  "comment-rm": { result: RemovedCommentResult };
  "comment-clear": { result: ClearedCommentsResult };
  "highlight-add": { result: AppliedHighlightResult };
  "highlight-clear": { result: ClearedHighlightsResult };
}

export type SessionDaemonResponse = SessionDaemonResponses[SessionDaemonAction];

import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  HunkSessionCommandResult,
  HunkSessionServerMessage,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
} from "./types";

export interface HunkSessionBridgeHandlers {
  addLiveComment: (
    input: Extract<HunkSessionServerMessage, { command: "comment" }>["input"],
    commentId: string,
    options?: { reveal?: boolean },
  ) => AppliedCommentResult;
  addLiveCommentBatch: (
    inputs: Extract<HunkSessionServerMessage, { command: "comment_batch" }>["input"]["comments"],
    requestId: string,
    options?: { revealMode?: "none" | "first" },
  ) => AppliedCommentBatchResult;
  clearLiveComments: (filePath?: string) => ClearedCommentsResult;
  navigateToLocation: (
    input: Extract<HunkSessionServerMessage, { command: "navigate_to_hunk" }>["input"],
  ) => NavigatedSelectionResult;
  openAgentNotes: () => void;
  reloadSession: (
    nextInput: Extract<
      HunkSessionServerMessage,
      { command: "reload_session" }
    >["input"]["nextInput"],
    options?: { resetApp?: boolean; sourcePath?: string },
  ) => Promise<ReloadedSessionResult>;
  removeLiveComment: (commentId: string) => RemovedCommentResult;
}

/** Build the app-facing bridge handler the generic broker client calls into for Hunk commands. */
export function createHunkSessionBridge(handlers: HunkSessionBridgeHandlers) {
  return {
    dispatchCommand: async (
      message: HunkSessionServerMessage,
    ): Promise<HunkSessionCommandResult> => {
      switch (message.command) {
        case "comment": {
          const result = handlers.addLiveComment(message.input, `mcp:${message.requestId}`, {
            reveal: message.input.reveal,
          });

          if (message.input.reveal ?? false) {
            handlers.openAgentNotes();
          }

          return result;
        }
        case "comment_batch": {
          const result = handlers.addLiveCommentBatch(message.input.comments, message.requestId, {
            revealMode: message.input.revealMode,
          });

          if (message.input.revealMode === "first" && result.applied.length > 0) {
            handlers.openAgentNotes();
          }

          return result;
        }
        case "navigate_to_hunk":
          return handlers.navigateToLocation(message.input);
        case "reload_session":
          return handlers.reloadSession(message.input.nextInput, {
            resetApp: false,
            sourcePath: message.input.sourcePath,
          });
        case "remove_comment":
          return handlers.removeLiveComment(message.input.commentId);
        case "clear_comments":
          return handlers.clearLiveComments(message.input.filePath);
      }
    },
  };
}

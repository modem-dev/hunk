import type { ReviewProducer } from "../review/producer";
import type {
  HunkReviewFailureV1,
  HunkReviewResourceReadResultV1,
} from "../../session/reviewProtocol";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  AppliedHighlightResult,
  ClearedCommentsResult,
  ClearedHighlightsResult,
  HunkSessionCommandResult,
  HunkSessionServerMessage,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
} from "../../session/types";
import { applySessionReviewAction, readSessionReviewResource } from "./reviewCommands";

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
  clearLiveComments: (
    filePath?: string,
    options?: { includeUser?: boolean },
  ) => ClearedCommentsResult;
  navigateToLocation: (
    input: Extract<HunkSessionServerMessage, { command: "navigate_to_hunk" }>["input"],
  ) => NavigatedSelectionResult;
  addAgentLineHighlight: (
    input: Extract<HunkSessionServerMessage, { command: "highlight" }>["input"],
  ) => AppliedHighlightResult;
  clearAgentLineHighlights: (filePath?: string) => ClearedHighlightsResult;
  openAgentNotes: () => void;
  reloadSession: (
    nextInput: Extract<
      HunkSessionServerMessage,
      { command: "reload_session" }
    >["input"]["nextInput"],
    options?: { resetApp?: boolean; sourcePath?: string },
  ) => Promise<ReloadedSessionResult>;
  removeLiveComment: (commentId: string) => RemovedCommentResult;
  /**
   * The producer serving this session's review, when one is mounted.
   *
   * Optional because a headless mount may bridge comment commands without ever
   * publishing a generation; a review command then answers with the same refusal a
   * caller would get for a review that has moved on, rather than throwing.
   */
  reviewProducer?: ReviewProducer;
}

/** The refusal a review command gets when this session serves no published review. */
function noReviewProducer(): HunkReviewFailureV1 {
  return {
    ok: false,
    code: "stale-generation",
    message: "This session is not serving a published review.",
    currentGeneration: "",
  };
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
        case "highlight":
          return handlers.addAgentLineHighlight(message.input);
        case "clear_highlights":
          return handlers.clearAgentLineHighlights(message.input.filePath);
        case "reload_session":
          return handlers.reloadSession(message.input.nextInput, {
            resetApp: false,
            sourcePath: message.input.sourcePath,
          });
        case "remove_comment":
          return handlers.removeLiveComment(message.input.commentId);
        case "clear_comments":
          return handlers.clearLiveComments(message.input.filePath, {
            includeUser: message.input.includeUser,
          });
        case "read_review_resource": {
          const producer = handlers.reviewProducer;
          const result: HunkReviewResourceReadResultV1 = producer
            ? await readSessionReviewResource(producer, message.input)
            : noReviewProducer();
          return result;
        }
        case "apply_review_action": {
          const producer = handlers.reviewProducer;
          return producer ? applySessionReviewAction(producer, message.input) : noReviewProducer();
        }
      }
    },
  };
}

/**
 * Holds the feedback form's state: the draft, which field has focus, and where a send stands.
 *
 * The form moves `editing → sending → sent | failed | unconfirmed | unavailable`. Sending is the
 * only transition that leaves the machine, and it carries the `submission_id` this reducer keeps:
 * a retry after `failed` or `unconfirmed` reuses it so Modem dedupes the repeat, while any edit to
 * the draft clears it so the next send is a new submission. Closing never sends; after an
 * unconfirmed send, the close prompt says the feedback may already have arrived. The draft lives
 * only here, in memory, and is never persisted. Rendering lives in `FeedbackDialog`; the request
 * and its controller live in `useFeedbackFormController`.
 */

import type { FeedbackSendResult } from "../../core/feedback/send";

export type FeedbackFormField = "message" | "email";

export type FeedbackFormStatus =
  | "editing"
  | "sending"
  | "sent"
  | "failed"
  | "unconfirmed"
  | "unavailable";

export interface FeedbackFormState {
  message: string;
  email: string;
  field: FeedbackFormField;
  status: FeedbackFormStatus;
  /** The idempotency key for the next send; null once an edit makes this a new submission. */
  submissionId: string | null;
  /** The validation error or send result shown under the inputs. */
  notice: string | null;
  /** Modem's event ID after a successful send. */
  sentId: string | null;
  /** Whether the close prompt is showing. */
  confirmingClose: boolean;
}

export type FeedbackFormAction =
  | { type: "edit"; field: FeedbackFormField; value: string }
  | { type: "focus"; field: FeedbackFormField }
  | { type: "toggleField" }
  | { type: "invalid"; error: string }
  | { type: "sendStarted"; submissionId: string }
  | { type: "sendFinished"; result: FeedbackSendResult }
  | { type: "requestClose" }
  | { type: "cancelClose" }
  | { type: "reset" };

export const INITIAL_FEEDBACK_FORM_STATE: FeedbackFormState = {
  message: "",
  email: "",
  field: "message",
  status: "editing",
  submissionId: null,
  notice: null,
  sentId: null,
  confirmingClose: false,
};

/** Return whether the draft has anything a close would throw away. */
export function feedbackDraftHasContent(state: FeedbackFormState) {
  return state.message.trim().length > 0 || state.email.trim().length > 0;
}

/** Return whether the inputs accept edits; they lock while a send is in flight or done. */
export function feedbackFormIsEditable(state: FeedbackFormState) {
  return state.status !== "sending" && state.status !== "sent" && !state.confirmingClose;
}

/**
 * Decide what a close request does: close at once, or ask first.
 *
 * Asking is the policy whenever closing would lose a draft or could leave the person wrong about
 * whether it was sent. Closing never cancels a send already accepted.
 */
export function feedbackCloseNeedsConfirmation(state: FeedbackFormState) {
  if (state.status === "sent" || state.status === "unavailable") {
    return false;
  }

  return state.status === "unconfirmed" || feedbackDraftHasContent(state);
}

/** The question the close prompt asks for the current state. */
export function feedbackCloseQuestion(state: FeedbackFormState) {
  return state.status === "unconfirmed"
    ? "Close? This feedback may already have been sent."
    : "Discard this feedback?";
}

/** Apply one action to the form state. */
export function reduceFeedbackForm(
  state: FeedbackFormState,
  action: FeedbackFormAction,
): FeedbackFormState {
  switch (action.type) {
    case "edit": {
      if (!feedbackFormIsEditable(state) || state[action.field] === action.value) {
        return state;
      }

      // An edited draft is a different submission; keep a failed result visible until resend.
      return {
        ...state,
        [action.field]: action.value,
        status: state.status === "unavailable" ? "unavailable" : "editing",
        submissionId: null,
        notice: state.status === "editing" ? null : state.notice,
      };
    }

    case "focus":
      return feedbackFormIsEditable(state) ? { ...state, field: action.field } : state;

    case "toggleField":
      return feedbackFormIsEditable(state)
        ? { ...state, field: state.field === "message" ? "email" : "message" }
        : state;

    case "invalid":
      return { ...state, status: "editing", notice: action.error };

    case "sendStarted":
      return {
        ...state,
        status: "sending",
        submissionId: action.submissionId,
        notice: null,
        confirmingClose: false,
      };

    case "sendFinished": {
      const { result } = action;
      if (result.kind === "sent") {
        return { ...state, status: "sent", sentId: result.id, notice: null };
      }

      return { ...state, status: result.kind, notice: result.message };
    }

    case "requestClose":
      return { ...state, confirmingClose: true };

    case "cancelClose":
      return { ...state, confirmingClose: false };

    case "reset":
      return INITIAL_FEEDBACK_FORM_STATE;
  }
}

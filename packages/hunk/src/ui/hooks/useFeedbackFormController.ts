/**
 * Runs the feedback form: Help → Send feedback in the review app and `hunk feedback` with no
 * message both open it, and its send action is the person's consent for that one submission.
 *
 * The controller owns the form's open state, its key routing, and the send. Nothing reaches
 * Modem until `submit` passes validation: the default sender is loaded with a dynamic import at
 * that moment, so opening, typing, and cancelling never load the module that knows the endpoint.
 * `esc` while sending stops waiting rather than pretending nothing was sent, which the reducer
 * reports as unconfirmed. Draft state and its transitions belong to `feedbackForm.ts`; layout
 * belongs to `FeedbackDialog`.
 */

import type { KeyEvent } from "@opentui/core";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  buildFeedbackPayload,
  createFeedbackSubmissionId,
  validateFeedbackDraft,
  type FeedbackEnvironment,
  type FeedbackPayload,
} from "../../core/feedback/payload";
import type { FeedbackSendResult } from "../../core/feedback/send";
import { resolveCliVersion } from "../../core/run/version";
import {
  feedbackCloseNeedsConfirmation,
  feedbackFormIsEditable,
  INITIAL_FEEDBACK_FORM_STATE,
  reduceFeedbackForm,
  type FeedbackFormField,
  type FeedbackFormState,
} from "../lib/feedbackForm";
import { isEscapeKey, isSaveDraftNoteKey } from "../lib/keyboard";
import type { KeyOwner } from "../lib/keyRouting";

/** Sends one confirmed payload. Injected by tests; the default loads `core/feedback/send`. */
export type SendFeedbackImpl = (
  payload: FeedbackPayload,
  deps: { signal: AbortSignal },
) => Promise<FeedbackSendResult>;

/** How long the thank-you state stays up before the form closes itself. */
export const FEEDBACK_SENT_CLOSE_DELAY_MS = 2_000;

export interface FeedbackFormControllerOptions {
  /** False when config turns feedback off; `open` is then a no-op. */
  enabled?: boolean;
  sendFeedback?: SendFeedbackImpl;
  environment?: FeedbackEnvironment;
  createSubmissionId?: () => string;
  /** Called after the form closes, with whether a send succeeded. */
  onClosed?: (outcome: { sent: boolean }) => void;
}

export interface FeedbackFormController {
  isOpen: boolean;
  state: FeedbackFormState;
  environment: FeedbackEnvironment;
  open: () => void;
  /** Close, or ask first when closing would lose a draft or hide an unconfirmed send. */
  requestClose: () => void;
  confirmClose: () => void;
  cancelClose: () => void;
  edit: (field: FeedbackFormField, value: string) => void;
  focus: (field: FeedbackFormField) => void;
  toggleField: () => void;
  submit: () => void;
  /** Route one key while the form is open; `"notMine"` when it is closed. */
  handleKey: (key: KeyEvent) => KeyOwner;
}

/** Load the real sender only once the person has pressed send. */
const loadDefaultSend: SendFeedbackImpl = async (payload, deps) =>
  (await import("../../core/feedback/send")).sendFeedback(payload, deps);

/** Own the feedback form's lifecycle for one surface. */
export function useFeedbackFormController({
  enabled = true,
  sendFeedback = loadDefaultSend,
  environment: suppliedEnvironment,
  createSubmissionId = createFeedbackSubmissionId,
  onClosed,
}: FeedbackFormControllerOptions = {}): FeedbackFormController {
  const [isOpen, setIsOpen] = useState(false);
  const [state, dispatch] = useReducer(reduceFeedbackForm, INITIAL_FEEDBACK_FORM_STATE);
  const [environment] = useState<FeedbackEnvironment>(
    () => suppliedEnvironment ?? { version: resolveCliVersion(), platform: process.platform },
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const abortRef = useRef<AbortController | null>(null);
  // Bumped on every close, so a send that settles after its form closed changes nothing.
  const generationRef = useRef(0);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  const open = useCallback(() => {
    if (enabled) setIsOpen(true);
  }, [enabled]);

  /** Close and discard the draft, which lives only in memory. The next opening starts blank. */
  const close = useCallback(() => {
    const sent = stateRef.current.status === "sent";
    generationRef.current += 1;
    abortRef.current = null;
    setIsOpen(false);
    dispatch({ type: "reset" });
    onClosedRef.current?.({ sent });
  }, []);

  const confirmClose = useCallback(() => {
    close();
  }, [close]);

  const cancelClose = useCallback(() => dispatch({ type: "cancelClose" }), []);

  const requestClose = useCallback(() => {
    const current = stateRef.current;
    if (current.status === "sending") {
      // Stop waiting; the reducer reports the outcome as unconfirmed.
      abortRef.current?.abort();
      return;
    }

    if (feedbackCloseNeedsConfirmation(current) && !current.confirmingClose) {
      dispatch({ type: "requestClose" });
      return;
    }

    close();
  }, [close]);

  const edit = useCallback(
    (field: FeedbackFormField, value: string) => dispatch({ type: "edit", field, value }),
    [],
  );
  const focus = useCallback((field: FeedbackFormField) => dispatch({ type: "focus", field }), []);
  const toggleField = useCallback(() => dispatch({ type: "toggleField" }), []);

  const submit = useCallback(() => {
    const current = stateRef.current;
    if (
      current.status === "sending" ||
      current.status === "sent" ||
      current.status === "unavailable" ||
      current.confirmingClose
    ) {
      return;
    }

    const validation = validateFeedbackDraft({ message: current.message, email: current.email });
    if (!validation.ok) {
      dispatch({ type: "invalid", error: validation.error });
      return;
    }

    const submissionId = current.submissionId ?? createSubmissionId();
    const payload = buildFeedbackPayload(validation.draft, {
      ...environment,
      surface: "tui",
      submissionId,
    });
    const controller = new AbortController();
    const generation = generationRef.current;
    abortRef.current = controller;
    dispatch({ type: "sendStarted", submissionId });

    void sendFeedback(payload, { signal: controller.signal })
      .catch(
        (): FeedbackSendResult => ({
          kind: "failed",
          message: "Hunk couldn't send the feedback. Try again later.",
        }),
      )
      .then((result) => {
        if (generation === generationRef.current) {
          dispatch({ type: "sendFinished", result });
        }
      });
  }, [createSubmissionId, environment, sendFeedback]);

  // Close the thank-you state on its own, so a successful send needs no further keypress.
  useEffect(() => {
    if (!isOpen || state.status !== "sent") return;
    const timer = setTimeout(close, FEEDBACK_SENT_CLOSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [close, isOpen, state.status]);

  const handleKey = useCallback(
    (key: KeyEvent): KeyOwner => {
      if (!isOpen) return "notMine";
      const current = stateRef.current;

      if (current.confirmingClose) {
        if (key.name === "return" || key.name === "enter" || key.name === "d") {
          confirmClose();
        } else if (isEscapeKey(key) || key.name === "k") {
          cancelClose();
        }
        return "mine";
      }

      if (current.status === "sent") {
        close();
        return "mine";
      }

      if (isEscapeKey(key)) {
        requestClose();
        return "mine";
      }

      if (isSaveDraftNoteKey(key)) {
        submit();
        return "mine";
      }

      if (key.name === "tab") {
        toggleField();
        return "mine";
      }

      // Everything else is text for the focused input, and never a review command.
      return feedbackFormIsEditable(current) ? "focused" : "mine";
    },
    [cancelClose, close, confirmClose, isOpen, requestClose, submit, toggleField],
  );

  return {
    isOpen,
    state,
    environment,
    open,
    requestClose,
    confirmClose,
    cancelClose,
    edit,
    focus,
    toggleField,
    submit,
    handleKey,
  };
}

import { describe, expect, test } from "bun:test";
import {
  feedbackCloseNeedsConfirmation,
  feedbackCloseQuestion,
  INITIAL_FEEDBACK_FORM_STATE,
  reduceFeedbackForm,
  type FeedbackFormAction,
  type FeedbackFormState,
} from "./feedbackForm";

/** Apply a sequence of actions to a fresh form. */
function runTestFeedbackForm(...actions: FeedbackFormAction[]): FeedbackFormState {
  return actions.reduce(reduceFeedbackForm, INITIAL_FEEDBACK_FORM_STATE);
}

describe("feedback form state", () => {
  test("keeps the submission ID across a retry and drops it on any edit", () => {
    const unconfirmed = runTestFeedbackForm(
      { type: "edit", field: "message", value: "hi" },
      { type: "sendStarted", submissionId: "id-1" },
      { type: "sendFinished", result: { kind: "unconfirmed", message: "maybe" } },
    );

    expect(unconfirmed.status).toBe("unconfirmed");
    expect(unconfirmed.submissionId).toBe("id-1");
    expect(
      reduceFeedbackForm(unconfirmed, { type: "edit", field: "message", value: "hi!" })
        .submissionId,
    ).toBeNull();
  });

  test("locks the draft while sending and after a send", () => {
    const sending = runTestFeedbackForm(
      { type: "edit", field: "message", value: "hi" },
      { type: "sendStarted", submissionId: "id-1" },
    );

    expect(reduceFeedbackForm(sending, { type: "edit", field: "message", value: "x" })).toBe(
      sending,
    );
    const sent = reduceFeedbackForm(sending, {
      type: "sendFinished",
      result: { kind: "sent", id: "evt" },
    });
    expect(sent.sentId).toBe("evt");
    expect(reduceFeedbackForm(sent, { type: "edit", field: "message", value: "x" })).toBe(sent);
  });

  test("asks before closing only when a draft would be lost or a send is unconfirmed", () => {
    expect(feedbackCloseNeedsConfirmation(INITIAL_FEEDBACK_FORM_STATE)).toBe(false);

    const drafted = runTestFeedbackForm({ type: "edit", field: "email", value: "a@b.c" });
    expect(feedbackCloseNeedsConfirmation(drafted)).toBe(true);
    expect(feedbackCloseQuestion(drafted)).toBe("Discard this feedback?");

    const unconfirmed = runTestFeedbackForm(
      { type: "sendStarted", submissionId: "id-1" },
      { type: "sendFinished", result: { kind: "unconfirmed", message: "maybe" } },
    );
    expect(feedbackCloseNeedsConfirmation(unconfirmed)).toBe(true);
    expect(feedbackCloseQuestion(unconfirmed)).toBe(
      "Close? This feedback may already have been sent.",
    );

    const sent = runTestFeedbackForm(
      { type: "edit", field: "message", value: "hi" },
      { type: "sendStarted", submissionId: "id-1" },
      { type: "sendFinished", result: { kind: "sent", id: "evt" } },
    );
    expect(feedbackCloseNeedsConfirmation(sent)).toBe(false);
  });

  test("reset discards the draft", () => {
    const drafted = runTestFeedbackForm({ type: "edit", field: "message", value: "hi" });

    expect(reduceFeedbackForm(drafted, { type: "reset" })).toEqual(INITIAL_FEEDBACK_FORM_STATE);
  });
});

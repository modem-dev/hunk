import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { TestAppHost as AppHost } from "../../../../test/helpers/app-host";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import type { FeedbackPayload } from "../core/feedback/payload";
import type { FeedbackSendResult } from "../core/feedback/send";
import type { SendFeedbackImpl } from "./hooks/useFeedbackFormController";

setDefaultTimeout(20_000);

type TestSetup = Awaited<ReturnType<typeof testRender>>;

/** Render a couple of frames so state updates and Suspense boundaries settle. */
async function flush(setup: TestSetup) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Render frames until a condition holds, and fail loudly with the frame when it never does. */
async function flushUntil(setup: TestSetup, predicate: () => boolean, description: string) {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}.\n${setup.captureCharFrame()}`);
    }
    await flush(setup);
    await act(async () => {
      await Bun.sleep(20);
    });
  }
}

/** Mount a review with the feedback form bound to ctrl+y and a recording sender. */
async function renderTestFeedbackReview(
  options: {
    result?: FeedbackSendResult | (() => Promise<FeedbackSendResult>);
    feedbackEnabled?: boolean;
  } = {},
) {
  const sent: FeedbackPayload[] = [];
  const signals: AbortSignal[] = [];
  const sendFeedback: SendFeedbackImpl = async (payload, deps) => {
    sent.push(payload);
    signals.push(deps.signal);
    const { result = { kind: "sent", id: "evt_42" } } = options;
    return typeof result === "function" ? result() : result;
  };
  const bootstrap = {
    ...createTestVcsAppBootstrap({
      files: [
        createTestDiffFile({
          id: "alpha",
          path: "alpha.ts",
          before: "export const alpha = 1;\n",
          after: "export const alpha = 2;\n",
        }),
      ],
    }),
    keybindings: { "hunk.app.openFeedback": "ctrl+y" },
    feedbackEnabled: options.feedbackEnabled,
  };
  const setup = await testRender(<AppHost bootstrap={bootstrap} sendFeedback={sendFeedback} />, {
    width: 120,
    height: 44,
  });
  await flushUntil(setup, () => setup.captureCharFrame().includes("alpha.ts"), "the review");
  return { setup, sent, signals };
}

/** Open the form through its bound key and wait for the disclosure. */
async function openTestFeedbackForm(setup: TestSetup) {
  await act(async () => {
    await setup.mockInput.pressKey("y", { ctrl: true });
  });
  await flushUntil(
    setup,
    () => setup.captureCharFrame().includes("Send feedback to the Hunk team"),
    "the feedback form",
  );
}

/** Type text into whichever form field has focus. */
async function typeTestFeedback(setup: TestSetup, text: string) {
  await act(async () => {
    await setup.mockInput.typeText(text);
  });
  await flush(setup);
}

describe("feedback form in the review app", () => {
  test("opening, typing, and cancelling never calls the sender", async () => {
    const { setup, sent } = await renderTestFeedbackReview();
    try {
      await openTestFeedbackForm(setup);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("This sends your message to the Modem team");
      expect(frame).toContain("IP address");

      await typeTestFeedback(setup, "jk]q");
      await flushUntil(setup, () => setup.captureCharFrame().includes("jk]q"), "typed text");

      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await typeTestFeedback(setup, "ada@example.com");

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Discard this feedback?"),
        "the discard prompt",
      );
      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("Send feedback to the Hunk team"),
        "the form to close",
      );

      await openTestFeedbackForm(setup);
      expect(setup.captureCharFrame()).not.toContain("jk]q");
      expect(sent).toHaveLength(0);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("ctrl+s sends the exact draft once and thanks the person", async () => {
    const { setup, sent } = await renderTestFeedbackReview();
    try {
      await openTestFeedbackForm(setup);
      await typeTestFeedback(setup, "Resize loses my place");
      await act(async () => {
        await setup.mockInput.pressKey("s", { ctrl: true });
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Sent. Thanks! Reference: evt_42"),
        "the thank-you state",
      );

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        message: "Resize loses my place",
        source: "tui",
        tags: { category: "user_feedback", os: process.platform, surface: "tui" },
      });
      expect(sent[0]).not.toHaveProperty("email");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("an empty draft is refused locally without calling the sender", async () => {
    const { setup, sent } = await renderTestFeedbackReview();
    try {
      await openTestFeedbackForm(setup);
      await act(async () => {
        await setup.mockInput.pressKey("s", { ctrl: true });
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Write a message first."),
        "the validation error",
      );
      expect(sent).toHaveLength(0);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("esc while sending reports an unconfirmed send and retries with the same ID", async () => {
    let release: (result: FeedbackSendResult) => void = () => {};
    const { setup, sent, signals } = await renderTestFeedbackReview({
      result: () =>
        new Promise<FeedbackSendResult>((resolve) => {
          release = resolve;
        }),
    });
    try {
      await openTestFeedbackForm(setup);
      await typeTestFeedback(setup, "Slow network");
      await act(async () => {
        await setup.mockInput.pressKey("s", { ctrl: true });
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Sending to Modem…"),
        "the sending state",
      );

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(setup, () => signals[0]?.aborted === true, "esc to abort the send");
      release({ kind: "unconfirmed", message: "Hunk couldn't confirm that Modem received this." });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("couldn't confirm"),
        "the unconfirmed state",
      );

      await act(async () => {
        await setup.mockInput.pressKey("s", { ctrl: true });
      });
      await flush(setup);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.submission_id).toBe(sent[0]?.submission_id);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("[feedback] enabled = false leaves the bound key and Help entry inert", async () => {
    const { setup } = await renderTestFeedbackReview({ feedbackEnabled: false });
    try {
      await act(async () => {
        await setup.mockInput.pressKey("y", { ctrl: true });
      });
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("Send feedback to the Hunk team");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});

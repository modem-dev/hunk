/**
 * Shows the feedback form on its own, for `hunk feedback` run in a terminal without a message.
 *
 * It mounts the same `FeedbackDialog` and controller as Help → Send feedback, so the disclosure,
 * consent, and send behave identically; only the backdrop differs. The process exits when the
 * form closes: 0 after a send or a cancel, 130 when interrupted. Starting the form makes no
 * request: the controller loads the sender only when the person presses send.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect } from "react";
import { FeedbackDialog } from "../components/chrome/FeedbackDialog";
import {
  useFeedbackFormController,
  type SendFeedbackImpl,
} from "../hooks/useFeedbackFormController";
import { runHunkSession } from "../session/runHunkSession";
import { resolveTheme } from "../themes";

/** Render the form over a blank backdrop and finish the session when it closes. */
export function StandaloneFeedbackForm({
  externalQuitSignal,
  onDone,
  sendFeedback,
}: {
  externalQuitSignal?: AbortSignal;
  onDone: (exitCode: number) => void;
  sendFeedback?: SendFeedbackImpl;
}) {
  const terminal = useTerminalDimensions();
  const theme = resolveTheme(undefined, null);
  const controller = useFeedbackFormController({
    sendFeedback,
    onClosed: () => onDone(0),
  });
  const { open } = controller;

  useEffect(() => {
    open();
  }, [open]);

  useEffect(() => {
    if (!externalQuitSignal) return;
    const quit = () => onDone(130);
    if (externalQuitSignal.aborted) {
      quit();
      return;
    }
    externalQuitSignal.addEventListener("abort", quit, { once: true });
    return () => externalQuitSignal.removeEventListener("abort", quit);
  }, [externalQuitSignal, onDone]);

  useKeyboard((key: KeyEvent) => {
    if (controller.handleKey(key) === "mine") {
      key.preventDefault();
      key.stopPropagation();
    }
  });

  return (
    <box style={{ width: "100%", height: "100%", backgroundColor: theme.background }}>
      {controller.isOpen ? (
        <FeedbackDialog
          controller={controller}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={theme}
        />
      ) : null}
    </box>
  );
}

/** Run the standalone form until it closes, returning the process exit status. */
export async function runFeedbackForm(): Promise<number> {
  const exitCode = await runHunkSession({
    stdin: process.stdin,
    stdout: process.stdout,
    useMouse: true,
    signals:
      process.platform === "win32"
        ? ["SIGINT", "SIGTERM", "SIGBREAK"]
        : ["SIGINT", "SIGTERM", "SIGHUP"],
    interruptExitCode: 130,
    render: ({ externalQuitSignal, finish }) => (
      <StandaloneFeedbackForm externalQuitSignal={externalQuitSignal} onDone={finish} />
    ),
  });

  return exitCode ?? 0;
}

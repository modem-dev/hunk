/**
 * Renders the feedback form: the full disclosure, the message and optional email inputs, the send
 * result, and a clickable action row.
 *
 * The disclosure is the consent text, so it always renders in full above the inputs and stays on
 * screen while the person types. When the terminal is short, the message box gives up rows, never
 * the disclosure. Keys are routed by `useFeedbackFormController`; this component handles only
 * mouse input and focus.
 */

import type { MouseEvent as TuiMouseEvent, TextareaRenderable } from "@opentui/core";
import { useRef } from "react";
import {
  describeFeedbackDisclosure,
  FEEDBACK_ISSUES_URL,
  FEEDBACK_MESSAGE_MAX_LENGTH,
} from "../../../core/feedback/payload";
import type { FeedbackFormController } from "../../hooks/useFeedbackFormController";
import {
  feedbackCloseQuestion,
  feedbackFormIsEditable,
  type FeedbackFormState,
} from "../../lib/feedbackForm";
import { MODAL_FRAME_CHROME_ROWS, resolveModalGeometry } from "../../lib/modalGeometry";
import { fitText, wrapText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import {
  ConfirmDialog,
  confirmDialogHeight,
  DialogActionRow,
  type ConfirmDialogAction,
} from "./ConfirmDialog";
import { ModalFrame } from "./ModalFrame";

const PREFERRED_WIDTH = 72;
const PREFERRED_MESSAGE_ROWS = 5;
const MIN_MESSAGE_ROWS = 2;
/** Show a character count once the message is this close to Modem's limit. */
const COUNTER_THRESHOLD = FEEDBACK_MESSAGE_MAX_LENGTH - 500;

/** Wrap the disclosure paragraphs, marking the first line so it reads as a warning. */
export function feedbackDisclosureRows(
  environment: FeedbackFormController["environment"],
  includesEmail: boolean,
  width: number,
) {
  const rows: string[] = [];
  const paragraphs = describeFeedbackDisclosure({ ...environment, includesEmail });
  paragraphs.forEach((paragraph, index) => {
    for (const line of wrapText(paragraph, Math.max(1, width - 2))) {
      rows.push(`${rows.length === 0 ? "⚠ " : "  "}${line}`);
    }
    if (index < paragraphs.length - 1) {
      rows.push("");
    }
  });
  return rows;
}

/** The action legend for the form's current state. */
function feedbackActions(controller: FeedbackFormController): ConfirmDialogAction[] {
  const { state } = controller;
  switch (state.status) {
    case "sending":
      return [{ keyLabel: "esc", label: "stop waiting", run: controller.requestClose }];
    case "sent":
      return [{ keyLabel: "any key", label: "close", run: controller.confirmClose }];
    case "unavailable":
      return [{ keyLabel: "esc", label: "close", run: controller.requestClose }];
    case "unconfirmed":
      return [
        { keyLabel: "ctrl+s", label: "send again", run: controller.submit },
        { keyLabel: "esc", label: "close", run: controller.requestClose },
      ];
    default:
      return [
        { keyLabel: "ctrl+s", label: "send to Modem", run: controller.submit },
        { keyLabel: "tab", label: "next field", run: controller.toggleField },
        { keyLabel: "esc", label: "cancel", run: controller.requestClose },
      ];
  }
}

/** The one status row under the inputs: progress, the send result, or a validation error. */
function feedbackStatusRow(state: FeedbackFormState, theme: AppTheme) {
  switch (state.status) {
    case "sending":
      return { text: "Sending to Modem…", color: theme.muted };
    case "sent":
      return {
        text: `Sent. Thanks!${state.sentId ? ` Reference: ${state.sentId}` : ""}`,
        color: theme.badgeAdded,
      };
    case "editing":
      if (state.notice) return { text: state.notice, color: theme.badgeRemoved };
      if (state.message.length >= COUNTER_THRESHOLD) {
        return {
          text: `${state.message.trim().length.toLocaleString("en-US")} / ${FEEDBACK_MESSAGE_MAX_LENGTH.toLocaleString("en-US")} characters`,
          color: theme.muted,
        };
      }
      return { text: "", color: theme.muted };
    default:
      return { text: state.notice ?? "", color: theme.badgeRemoved };
  }
}

/** Render the feedback form for one open controller. */
export function FeedbackDialog({
  controller,
  terminalHeight,
  terminalWidth,
  theme,
}: {
  controller: FeedbackFormController;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
}) {
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const { state } = controller;
  const editable = feedbackFormIsEditable(state);
  const width = Math.min(PREFERRED_WIDTH, Math.max(40, terminalWidth - 4));
  const frameWidth = resolveModalGeometry({
    width,
    height: 1,
    terminalWidth,
    terminalHeight,
  }).width;
  const bodyWidth = Math.max(1, frameWidth - 4);
  const fieldWidth = Math.max(1, bodyWidth - 2);
  const disclosure = feedbackDisclosureRows(
    controller.environment,
    state.email.trim().length > 0,
    bodyWidth,
  );
  const status = feedbackStatusRow(state, theme);
  const statusRows = wrapText(status.text, bodyWidth).slice(0, 3);

  // Fixed rows: disclosure, gap, message label, message borders, email label, email box, status,
  // issues link, plus the frame chrome, action gap, and action row.
  const fixedRows =
    disclosure.length + 1 + 1 + 2 + 1 + 3 + statusRows.length + 1 + MODAL_FRAME_CHROME_ROWS + 2;
  const availableRows = Math.max(1, terminalHeight - 2);
  const messageRows = Math.max(
    MIN_MESSAGE_ROWS,
    Math.min(PREFERRED_MESSAGE_ROWS, availableRows - fixedRows),
  );
  const height = fixedRows + messageRows;
  const fieldBorder = (field: "message" | "email") =>
    editable && state.field === field ? theme.accent : theme.border;

  return (
    <>
      <ModalFrame
        height={height}
        terminalHeight={terminalHeight}
        terminalWidth={terminalWidth}
        theme={theme}
        title="Send feedback to the Hunk team"
        width={width}
        onClose={controller.requestClose}
      >
        <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
          {disclosure.map((line, index) => (
            <box
              key={`disclosure:${index}`}
              style={{ width: "100%", height: 1, flexDirection: "row" }}
            >
              <text fg={theme.accent}>{line.slice(0, 2)}</text>
              <text fg={theme.text}>{fitText(line.slice(2), Math.max(1, bodyWidth - 2))}</text>
            </box>
          ))}
          <box style={{ width: "100%", height: 1 }} />
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.badgeNeutral}>Message</text>
          </box>
          <box
            style={{
              width: bodyWidth,
              height: messageRows + 2,
              border: true,
              borderColor: fieldBorder("message"),
              paddingLeft: 1,
            }}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              controller.focus("message");
            }}
          >
            <textarea
              ref={textareaRef}
              width={fieldWidth - 1}
              height={messageRows}
              initialValue={state.message}
              placeholder="What's working, what isn't, what you wish Hunk did…"
              focused={editable && state.field === "message"}
              wrapMode="word"
              backgroundColor={theme.panel}
              textColor={theme.text}
              focusedBackgroundColor={theme.panel}
              focusedTextColor={theme.text}
              keyBindings={[{ name: "j", ctrl: true, action: "newline" }]}
              onContentChange={() => {
                controller.edit("message", textareaRef.current?.plainText ?? "");
              }}
            />
          </box>
          <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
            <text fg={theme.badgeNeutral}>Email</text>
            <text fg={theme.muted}> (optional, only if you want a reply)</text>
          </box>
          <box
            style={{
              width: bodyWidth,
              height: 3,
              border: true,
              borderColor: fieldBorder("email"),
              paddingLeft: 1,
            }}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              controller.focus("email");
            }}
          >
            <input
              width={fieldWidth - 1}
              value={state.email}
              placeholder="you@example.com"
              focused={editable && state.field === "email"}
              backgroundColor={theme.panel}
              textColor={theme.text}
              focusedBackgroundColor={theme.panel}
              focusedTextColor={theme.text}
              onInput={(value) => controller.edit("email", value)}
            />
          </box>
          {statusRows.map((line, index) => (
            <box key={`status:${index}`} style={{ width: "100%", height: 1 }}>
              <text fg={status.color}>{line}</text>
            </box>
          ))}
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.muted}>
              {fitText(
                `Bug with steps to reproduce? ${FEEDBACK_ISSUES_URL.replace("https://", "")}`,
                bodyWidth,
              )}
            </text>
          </box>
          <box style={{ width: "100%", height: 1 }} />
          <DialogActionRow actions={feedbackActions(controller)} theme={theme} />
        </box>
      </ModalFrame>

      {state.confirmingClose ? (
        <ConfirmDialog
          actions={[
            {
              keyLabel: "enter/d",
              label: state.status === "unconfirmed" ? "close" : "discard",
              run: controller.confirmClose,
            },
            { keyLabel: "esc/k", label: "keep editing", run: controller.cancelClose },
          ]}
          height={confirmDialogHeight(1)}
          terminalHeight={terminalHeight}
          terminalWidth={terminalWidth}
          theme={theme}
          title={feedbackCloseQuestion(state)}
          width={56}
          onClose={controller.cancelClose}
        >
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.muted}>
              {state.status === "unconfirmed"
                ? "Closing never sends anything."
                : "Nothing has been sent. The draft is not saved anywhere."}
            </text>
          </box>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

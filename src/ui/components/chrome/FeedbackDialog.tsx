import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { submitFeedback } from "../../../core/feedback";
import { isEscapeKey, isSaveDraftNoteKey } from "../../lib/keyboard";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

type FeedbackDialogStatus = "editing" | "submitting" | "success" | "failure";

const DESCRIPTION_ROWS = 6;
const AUTO_DISMISS_MS = 2500;

/** Resolve the failure copy shown for a submission outcome. */
function failureMessage(reason: "not-configured" | "network-error" | "http-error" | undefined) {
  if (reason === "not-configured") {
    return "Feedback isn't configured in this build.";
  }

  return "Couldn't send feedback — check your connection.";
}

/** Render the feedback dialog: a multiline description, optional email, and submission states. */
export function FeedbackDialog({
  terminalHeight,
  terminalWidth,
  theme,
  onClose,
}: {
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<FeedbackDialogStatus>("editing");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [focusedField, setFocusedField] = useState<"description" | "email">("description");
  const [failureReason, setFailureReason] = useState<
    "not-configured" | "network-error" | "http-error" | undefined
  >(undefined);
  const descriptionRef = useRef<TextareaRenderable | null>(null);
  const submissionTokenRef = useRef(0);
  const autoDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      submissionTokenRef.current += 1;
      if (autoDismissTimerRef.current) {
        clearTimeout(autoDismissTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (status !== "success") {
      return;
    }

    autoDismissTimerRef.current = setTimeout(() => {
      onClose();
    }, AUTO_DISMISS_MS);

    return () => {
      if (autoDismissTimerRef.current) {
        clearTimeout(autoDismissTimerRef.current);
        autoDismissTimerRef.current = null;
      }
    };
  }, [status, onClose]);

  const canSubmit = status === "editing" && description.trim().length > 0;

  const submit = () => {
    if (!canSubmit) {
      return;
    }

    setStatus("submitting");
    const token = ++submissionTokenRef.current;
    const trimmedEmail = email.trim();

    void submitFeedback({
      description: description.trim(),
      email: trimmedEmail.length > 0 ? trimmedEmail : undefined,
    }).then((result) => {
      if (submissionTokenRef.current !== token) {
        // The dialog was closed or resubmitted before this request resolved.
        return;
      }

      if (result.ok) {
        setStatus("success");
        return;
      }

      setFailureReason(result.reason);
      setStatus("failure");
    });
  };

  const width = Math.min(70, Math.max(50, terminalWidth - 8));
  const bodyWidth = Math.max(1, width - 4);
  const height = Math.min(
    status === "editing" || status === "submitting" ? DESCRIPTION_ROWS + 9 : 8,
    Math.max(8, terminalHeight - 2),
  );

  const handleDismissKey = (key: KeyEvent) => {
    key.preventDefault();
    key.stopPropagation();
    onClose();
  };

  return (
    <ModalFrame
      height={height}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Send feedback"
      width={width}
      onClose={onClose}
    >
      {status === "success" ? (
        <box
          style={{ width: "100%", flexDirection: "column" }}
          onMouseUp={onClose}
          onKeyDown={handleDismissKey}
        >
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.badgeAdded}>Thanks — feedback sent.</text>
          </box>
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.muted}>{"Press any key to close."}</text>
          </box>
        </box>
      ) : status === "failure" ? (
        <box
          style={{ width: "100%", flexDirection: "column" }}
          onMouseUp={onClose}
          onKeyDown={handleDismissKey}
        >
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.badgeRemoved}>{failureMessage(failureReason)}</text>
          </box>
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.muted}>{"Press any key to close."}</text>
          </box>
        </box>
      ) : (
        <box style={{ width: "100%", flexDirection: "column" }}>
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.badgeNeutral}>
              {padText(fitText("Description", bodyWidth), bodyWidth)}
            </text>
          </box>
          <box
            style={{
              width: "100%",
              height: DESCRIPTION_ROWS,
              border: true,
              borderColor: theme.border,
            }}
          >
            <textarea
              ref={descriptionRef}
              width="100%"
              height="100%"
              initialValue={description}
              placeholder="What's on your mind?"
              focused={status === "editing" && focusedField === "description"}
              backgroundColor={theme.panel}
              textColor={theme.text}
              focusedBackgroundColor={theme.panel}
              focusedTextColor={theme.text}
              keyBindings={[{ name: "j", ctrl: true, action: "newline" }]}
              onContentChange={() => {
                setDescription(descriptionRef.current?.plainText ?? "");
              }}
              onKeyDown={(key) => {
                if (key.name === "tab") {
                  key.preventDefault();
                  key.stopPropagation();
                  setFocusedField("email");
                  return;
                }

                if (isSaveDraftNoteKey(key)) {
                  key.preventDefault();
                  key.stopPropagation();
                  submit();
                  return;
                }

                if (isEscapeKey(key)) {
                  key.preventDefault();
                  key.stopPropagation();
                  onClose();
                }
              }}
            />
          </box>

          <box style={{ width: "100%", height: 1 }} />

          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.badgeNeutral}>
              {padText(fitText("Email (optional)", bodyWidth), bodyWidth)}
            </text>
          </box>
          <input
            width={bodyWidth}
            value={email}
            placeholder="you@example.com"
            focused={status === "editing" && focusedField === "email"}
            onInput={setEmail}
            onSubmit={submit}
            onKeyDown={(key) => {
              if (key.name === "tab") {
                key.preventDefault();
                key.stopPropagation();
                setFocusedField("description");
                return;
              }

              if (isSaveDraftNoteKey(key)) {
                key.preventDefault();
                key.stopPropagation();
                submit();
                return;
              }

              if (isEscapeKey(key)) {
                key.preventDefault();
                key.stopPropagation();
                onClose();
              }
            }}
          />

          <box style={{ width: "100%", height: 1 }} />

          <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
            <box onMouseUp={submit} style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
              <text fg={canSubmit ? theme.badgeAdded : theme.muted}>
                {status === "submitting" ? "Sending… (Ctrl+S)" : "Send (Ctrl+S / Enter on email)"}
              </text>
            </box>
            <box onMouseUp={onClose} style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
              <text fg={theme.muted}>Cancel (Esc)</text>
            </box>
          </box>
        </box>
      )}
    </ModalFrame>
  );
}

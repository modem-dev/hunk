import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  createExtensionDialogQueue,
  type ExtensionDialogQueue,
  type ExtensionDialogRequest,
} from "../lib/extensionDialogs";

export interface ExtensionDialogController {
  /** Build the dialog capability one extension command receives. */
  createDialogs: ExtensionDialogQueue["createDialogs"];
  /** Request currently visible to the user. */
  request: ExtensionDialogRequest | null;
  selectedIndex: number;
  inputValue: string;
  accept: (selectedIndexOverride?: number) => void;
  cancel: () => void;
  moveSelection: (delta: number) => void;
  pickOption: (index: number) => void;
  updateInput: (value: string) => void;
}

/** Own the React state and lifetime of one App instance's extension-dialog queue. */
export function useExtensionDialogController({
  reviewGeneration,
}: {
  /** Identity token replaced whenever a soft reload swaps the review beneath an open dialog. */
  reviewGeneration: unknown;
}): ExtensionDialogController {
  const [queue] = useState(createExtensionDialogQueue);
  const request = useSyncExternalStore(queue.subscribe, queue.current, queue.current);
  const [answer, setAnswer] = useState({
    requestId: request?.id,
    selectedIndex: 0,
    inputValue: "",
  });
  const answerRef = useRef(answer);
  const currentAnswer =
    answer.requestId === request?.id
      ? answer
      : {
          requestId: request?.id,
          selectedIndex: 0,
          inputValue: request?.kind === "input" ? request.initial : "",
        };

  /** Read edits synchronously, even when another key arrives before React commits. */
  const readAnswer = () =>
    answerRef.current.requestId === request?.id ? answerRef.current : currentAnswer;

  /** Keep the visible answer and the next keypress scoped to the same request. */
  const updateAnswer = (patch: Partial<Pick<typeof answer, "selectedIndex" | "inputValue">>) => {
    const next = { ...readAnswer(), ...patch };
    answerRef.current = next;
    setAnswer(next);
  };

  const previousReviewGenerationRef = useRef(reviewGeneration);
  useLayoutEffect(() => {
    if (previousReviewGenerationRef.current !== reviewGeneration) {
      previousReviewGenerationRef.current = reviewGeneration;
      // Child layout effects run before AppHost publishes lifecycle events for
      // the committed generation. Drain only the retired review's requests so
      // a session_reload handler can safely open the replacement's first dialog.
      queue.cancelAll();
    }
  }, [queue, reviewGeneration]);

  useEffect(() => {
    // Settle every pending handler when this App instance leaves the review tree.
    return () => queue.shutdown();
  }, [queue]);

  /** Answer the visible request with the state appropriate to its dialog kind. */
  const accept = (selectedIndexOverride?: number) => {
    if (!request) return;

    if (request.kind === "select") {
      queue.accept(
        request.id,
        request.options[selectedIndexOverride ?? readAnswer().selectedIndex],
      );
      return;
    }

    queue.accept(request.id, request.kind === "input" ? readAnswer().inputValue : undefined);
  };

  /** Dismiss the visible request with its kind-specific cancel value. */
  const cancel = () => {
    if (request) queue.cancel(request.id);
  };

  /** Move a select request's highlight, wrapping at both ends. */
  const moveSelection = (delta: number) => {
    if (request?.kind !== "select") return;

    const optionCount = request.options.length;
    updateAnswer({
      selectedIndex: (readAnswer().selectedIndex + delta + optionCount) % optionCount,
    });
  };

  return {
    createDialogs: queue.createDialogs,
    request,
    selectedIndex: currentAnswer.selectedIndex,
    inputValue: currentAnswer.inputValue,
    accept,
    cancel,
    moveSelection,
    pickOption: (selectedIndex) => updateAnswer({ selectedIndex }),
    updateInput: (inputValue) => updateAnswer({ inputValue }),
  };
}

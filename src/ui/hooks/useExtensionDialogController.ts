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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const requestId = request?.id ?? null;
  const initialInput = request?.kind === "input" ? request.initial : "";

  useEffect(() => {
    // A promoted queued request must never inherit the previous request's answer state.
    setSelectedIndex(0);
    setInputValue(initialInput);
  }, [initialInput, requestId]);

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
      queue.accept(request.id, request.options[selectedIndexOverride ?? selectedIndex]);
      return;
    }

    queue.accept(request.id, request.kind === "input" ? inputValue : undefined);
  };

  /** Dismiss the visible request with its kind-specific cancel value. */
  const cancel = () => {
    if (request) queue.cancel(request.id);
  };

  /** Move a select request's highlight, wrapping at both ends. */
  const moveSelection = (delta: number) => {
    if (request?.kind !== "select") return;

    const optionCount = request.options.length;
    setSelectedIndex((current) => (current + delta + optionCount) % optionCount);
  };

  return {
    createDialogs: queue.createDialogs,
    request,
    selectedIndex,
    inputValue,
    accept,
    cancel,
    moveSelection,
    pickOption: setSelectedIndex,
    updateInput: setInputValue,
  };
}

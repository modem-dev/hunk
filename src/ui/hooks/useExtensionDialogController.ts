import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  createExtensionDialogQueue,
  type ExtensionDialogQueue,
  type ExtensionDialogRequest,
} from "../lib/extensionDialogs";

export interface ExtensionDialogController {
  /** Build the dialog capability one extension command receives. */
  createDialogs: ExtensionDialogQueue["createDialogs"];
  /** Read the queue's live request rather than a render-time snapshot. */
  getCurrentRequest: ExtensionDialogQueue["current"];
  /** Check request identity and generation liveness at the moment an action runs. */
  isCurrentRequestLive: ExtensionDialogQueue["isCurrentLive"];
  /** Cancel one request only while it remains at the front of the queue. */
  cancelRequest: ExtensionDialogQueue["cancel"];
  /** Request currently visible to the user. */
  request: ExtensionDialogRequest | null;
  selectedIndex: number;
  inputValue: string;
  accept: (selectedIndexOverride?: number) => void;
  /** Accept only the rendered request with this id; stale controls are ignored. */
  acceptRequest: (requestId: number, selectedIndexOverride?: number) => void;
  cancel: () => void;
  /** Cancel the visible request and every queued request with their kind-specific values. */
  cancelAll: () => void;
  moveSelection: (delta: number) => void;
  pickOption: (requestId: number, index: number) => void;
  updateInput: (requestId: number, value: string) => void;
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
  const selectedIndexRef = useRef(0);
  const inputValueRef = useRef("");
  const answerRequestIdRef = useRef<number | null>(null);
  /** Align mutable answer state before another key can arrive ahead of React. */
  const alignAnswerState = useCallback((active: ExtensionDialogRequest | null) => {
    const activeId = active?.id ?? null;
    if (answerRequestIdRef.current === activeId) return;

    answerRequestIdRef.current = activeId;
    selectedIndexRef.current = 0;
    inputValueRef.current = active?.kind === "input" ? active.initial : "";
  }, []);

  alignAnswerState(request);

  useEffect(() => {
    // A promoted queued request must never inherit the previous request's answer state.
    alignAnswerState(request);
    setSelectedIndex(selectedIndexRef.current);
    setInputValue(inputValueRef.current);
  }, [alignAnswerState, request]);

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

  useLayoutEffect(() => {
    // Retire capabilities before custom component layout cleanups can retain or
    // invoke actions from a dialog whose App is already leaving the tree.
    return () => queue.shutdown();
  }, [queue]);

  /** Answer one rendered request only while it remains current. */
  const acceptRequest = useCallback(
    (requestId: number, selectedIndexOverride?: number) => {
      const active = queue.current();
      alignAnswerState(active);
      if (!active || active.id !== requestId) return;

      if (active.kind === "select") {
        queue.accept(active.id, active.options[selectedIndexOverride ?? selectedIndexRef.current]);
        alignAnswerState(queue.current());
        return;
      }

      queue.accept(active.id, active.kind === "input" ? inputValueRef.current : undefined);
      alignAnswerState(queue.current());
    },
    [alignAnswerState, queue],
  );

  /** Answer the live request with the state appropriate to its dialog kind. */
  const accept = (selectedIndexOverride?: number) => {
    const active = queue.current();
    if (active) acceptRequest(active.id, selectedIndexOverride);
  };

  /** Dismiss the visible request with its kind-specific cancel value. */
  const cancel = () => {
    const active = queue.current();
    if (active) queue.cancel(active.id);
    alignAnswerState(queue.current());
  };

  /** Move a select request's highlight, wrapping at both ends. */
  const moveSelection = (delta: number) => {
    const active = queue.current();
    alignAnswerState(active);
    if (active?.kind !== "select") return;

    const optionCount = active.options.length;
    const next = (selectedIndexRef.current + delta + optionCount) % optionCount;
    selectedIndexRef.current = next;
    setSelectedIndex(next);
  };

  /** Cancel one live request and synchronously prepare any promoted answer state. */
  const cancelRequest = useCallback(
    (id: number) => {
      queue.cancel(id);
      alignAnswerState(queue.current());
    },
    [alignAnswerState, queue],
  );

  /** Drain every request and synchronously clear its mutable answer state. */
  const cancelAll = useCallback(() => {
    queue.cancelAll();
    alignAnswerState(queue.current());
  }, [alignAnswerState, queue]);

  /** Select one option while keeping the same-flush answer state current. */
  const pickOption = (requestId: number, index: number) => {
    const active = queue.current();
    alignAnswerState(active);
    if (active?.kind !== "select" || active.id !== requestId) return;

    selectedIndexRef.current = index;
    setSelectedIndex(index);
  };

  /** Update input text in both React and same-flush answer state. */
  const updateInput = (requestId: number, value: string) => {
    const active = queue.current();
    alignAnswerState(active);
    if (active?.kind !== "input" || active.id !== requestId) return;

    inputValueRef.current = value;
    setInputValue(value);
  };

  return {
    createDialogs: queue.createDialogs,
    getCurrentRequest: queue.current,
    isCurrentRequestLive: queue.isCurrentLive,
    cancelRequest,
    request,
    selectedIndex,
    inputValue,
    accept,
    acceptRequest,
    cancel,
    cancelAll,
    moveSelection,
    pickOption,
    updateInput,
  };
}

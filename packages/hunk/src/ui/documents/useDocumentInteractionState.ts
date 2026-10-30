import { useCallback, useRef, useState } from "react";

interface DocumentInteractionState {
  focus: "tree" | "document";
  sidebar: boolean;
  help: boolean;
}

/** Publish focus and help changes synchronously for keyboard bursts and pointer actions.
 * React renders the projection; command routing reads the state updated by every action.
 */
export function useDocumentInteractionState(initial: DocumentInteractionState) {
  const liveState = useRef(initial);
  const [state, setState] = useState(initial);

  const update = useCallback(
    (change: (current: DocumentInteractionState) => DocumentInteractionState) => {
      const next = change(liveState.current);
      liveState.current = next;
      setState(next);
    },
    [],
  );

  const getSnapshot = useCallback(() => liveState.current, []);

  return { state, update, getSnapshot };
}

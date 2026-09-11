/**
 * Owns one surface's status-line store for the life of its mount.
 *
 * Reload cancels open and queued prompts the way `useExtensionDialogController` drains dialogs:
 * the review a prompt was asked about is being replaced, and this child layout effect runs
 * before the parent publishes lifecycle events for the new generation. Unmount shuts the store
 * down so every awaiting consumer settles.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createStatusLineStore, type StatusLineStore } from "./store";
import type { StatusLineSnapshot } from "./types";

export function useStatusLine({
  reviewGeneration,
}: {
  /** Identity token replaced whenever a reload swaps the content beneath an open prompt. */
  reviewGeneration?: unknown;
} = {}): { store: StatusLineStore; snapshot: StatusLineSnapshot } {
  const [store] = useState(createStatusLineStore);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const previousGenerationRef = useRef(reviewGeneration);
  useLayoutEffect(() => {
    if (previousGenerationRef.current !== reviewGeneration) {
      previousGenerationRef.current = reviewGeneration;
      store.cancelAllPrompts();
    }
  }, [reviewGeneration, store]);

  useEffect(() => {
    return () => store.shutdown();
  }, [store]);

  return { store, snapshot };
}

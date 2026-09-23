/**
 * Owns one surface's status-line store for the life of its mount.
 *
 * Watch and manual content reloads cancel extension prompts but preserve opted-in host inputs,
 * including the focused file filter. This child layout effect settles reload-scoped requests
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
      store.cancelReloadPrompts();
    }
  }, [reviewGeneration, store]);

  useEffect(() => {
    return () => store.shutdown();
  }, [store]);

  return { store, snapshot };
}

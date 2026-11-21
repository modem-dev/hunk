/**
 * Tracks the review or docked pane the user most recently engaged.
 *
 * Pointer activation and focused descendants converge here while modal focus leaves the underlying
 * workspace surface intact. Panes that leave the committed layout fall back to the review.
 */

import type { BoxRenderable, CliRenderer, Renderable } from "@opentui/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Resolve a focused renderable to its containing workspace surface, when it has one. */
export function paneKeyFromFocusedRenderable(
  renderable: Renderable | null,
  surfaceRoots: ReadonlyMap<Renderable, string | null>,
): string | null | undefined {
  let current = renderable;
  while (current) {
    if (surfaceRoots.has(current)) return surfaceRoots.get(current);
    current = current.parent;
  }
  return undefined;
}

/** Own logical workspace activation independently from concrete OpenTUI editor focus. */
export function useActivePaneController({
  renderer,
  visiblePaneKeys,
}: {
  renderer: CliRenderer;
  visiblePaneKeys: readonly string[];
}) {
  const [activePaneKey, setActivePaneKey] = useState<string | null>(null);
  const surfaceRootsRef = useRef(new Map<Renderable, string | null>());
  const paneRootsRef = useRef(new Map<string, BoxRenderable>());
  const paneRootCallbacksRef = useRef(
    new Map<string, (renderable: BoxRenderable | null) => void>(),
  );
  const reviewRootRef = useRef<BoxRenderable | null>(null);
  const visiblePaneKeysRef = useRef(visiblePaneKeys);

  const paneSurfaceRef = useCallback((paneKey: string) => {
    let callback = paneRootCallbacksRef.current.get(paneKey);
    if (!callback) {
      callback = (renderable) => {
        const previous = paneRootsRef.current.get(paneKey);
        if (previous) surfaceRootsRef.current.delete(previous);
        if (renderable) {
          paneRootsRef.current.set(paneKey, renderable);
          surfaceRootsRef.current.set(renderable, paneKey);
        } else {
          paneRootsRef.current.delete(paneKey);
        }
      };
      paneRootCallbacksRef.current.set(paneKey, callback);
    }
    return callback;
  }, []);

  const reviewSurfaceRef = useCallback((renderable: BoxRenderable | null) => {
    if (reviewRootRef.current) surfaceRootsRef.current.delete(reviewRootRef.current);
    reviewRootRef.current = renderable;
    if (renderable) surfaceRootsRef.current.set(renderable, null);
  }, []);

  useEffect(() => {
    let live = true;
    const activateFocusedSurface = (current: Renderable | null) => {
      const paneKey = paneKeyFromFocusedRenderable(current, surfaceRootsRef.current);
      if (
        paneKey === undefined ||
        (paneKey !== null && !visiblePaneKeysRef.current.includes(paneKey))
      ) {
        return false;
      }
      setActivePaneKey(paneKey);
      return true;
    };
    const syncFocusedSurface = (current: Renderable | null) => {
      if (activateFocusedSurface(current) || !current) return;
      // Newly focused renderables can emit before React attaches their host-pane ancestry.
      queueMicrotask(() => {
        if (live && renderer.currentFocusedRenderable === current) activateFocusedSurface(current);
      });
    };
    renderer.on("focused_renderable", syncFocusedSurface);
    syncFocusedSurface(renderer.currentFocusedRenderable);
    return () => {
      live = false;
      renderer.off("focused_renderable", syncFocusedSurface);
    };
  }, [renderer]);

  useLayoutEffect(() => {
    visiblePaneKeysRef.current = visiblePaneKeys;
    setActivePaneKey((current) =>
      current !== null && !visiblePaneKeys.includes(current) ? null : current,
    );
  }, [visiblePaneKeys]);

  const activatePane = useCallback((paneKey: string) => setActivePaneKey(paneKey), []);
  const activateReview = useCallback(() => setActivePaneKey(null), []);

  return {
    activePaneKey,
    activatePane,
    activateReview,
    paneSurfaceRef,
    reviewSurfaceRef,
  };
}

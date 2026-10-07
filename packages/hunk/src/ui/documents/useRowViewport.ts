import type { ScrollBoxRenderable } from "@opentui/core";
import { useLayoutEffect, useRef, useState } from "react";

/** Observe scroll geometry so complete-document and tree panes mount only a bounded row window. */
export function useRowViewport(estimatedHeight: number, estimatedWidth: number) {
  const ref = useRef<ScrollBoxRenderable | null>(null);
  // Keep callback ownership stable across resize; scroll anchoring chains these native callbacks.
  const estimate = useRef({ height: estimatedHeight, width: estimatedWidth });
  estimate.current = { height: estimatedHeight, width: estimatedWidth };
  const [viewport, setViewport] = useState({
    top: 0,
    height: estimatedHeight,
    width: estimatedWidth,
  });
  useLayoutEffect(() => {
    const scroll = ref.current;
    if (!scroll) return;
    const update = () =>
      setViewport((previous) => {
        const next = {
          // Native layout can clamp against an empty content extent before the first row commit.
          top: Math.max(0, Math.floor(scroll.scrollTop)),
          height: Math.max(1, scroll.viewport.height || estimate.current.height),
          width: Math.max(1, scroll.viewport.width || estimate.current.width),
        };
        return previous.top === next.top &&
          previous.height === next.height &&
          previous.width === next.width
          ? previous
          : next;
      });
    // Yoga size changes use this callback, not the explicit resize/layout events.
    const previousSizeChange = scroll.viewport.onSizeChange;
    const onSizeChange = () => {
      previousSizeChange?.call(scroll.viewport);
      update();
    };
    scroll.viewport.onSizeChange = onSizeChange;
    update();
    scroll.verticalScrollBar.on("change", update);
    return () => {
      scroll.verticalScrollBar.off("change", update);
      if (scroll.viewport.onSizeChange === onSizeChange)
        scroll.viewport.onSizeChange = previousSizeChange;
    };
  }, []);
  return { ref, ...viewport };
}

/** Include a small halo around the viewport, clamping after document replacement or resize. */
export function mountedRowWindow(count: number, top: number, height: number) {
  const start = Math.max(0, Math.min(count, top - 5));
  return { start, end: Math.min(count, Math.max(start, top + height + 5)) };
}

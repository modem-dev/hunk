import type { ScrollBoxRenderable } from "@opentui/core";
import { useLayoutEffect, useRef, useState } from "react";

/** Observe scroll geometry so complete-document and tree panes mount only a bounded row window. */
export function useRowViewport(estimatedHeight: number) {
  const ref = useRef<ScrollBoxRenderable | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: estimatedHeight });
  useLayoutEffect(() => {
    const scroll = ref.current;
    if (!scroll) return;
    const update = () =>
      setViewport((previous) => {
        const next = {
          top: Math.floor(scroll.scrollTop),
          height: Math.max(1, scroll.viewport.height || estimatedHeight),
        };
        return previous.top === next.top && previous.height === next.height ? previous : next;
      });
    update();
    scroll.verticalScrollBar.on("change", update);
    scroll.viewport.on("layout-changed", update);
    scroll.viewport.on("resized", update);
    return () => {
      scroll.verticalScrollBar.off("change", update);
      scroll.viewport.off("layout-changed", update);
      scroll.viewport.off("resized", update);
    };
  }, [estimatedHeight]);
  return { ref, ...viewport };
}

/** Include a small halo around the viewport, clamping after document replacement or resize. */
export function mountedRowWindow(count: number, top: number, height: number) {
  const start = Math.max(0, Math.min(count, top - 5));
  return { start, end: Math.min(count, Math.max(start, top + height + 5)) };
}

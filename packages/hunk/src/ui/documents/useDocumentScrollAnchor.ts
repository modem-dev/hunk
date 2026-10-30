import type { ScrollBoxRenderable } from "@opentui/core";
import { useLayoutEffect, useRef, type MutableRefObject } from "react";
import {
  completeDocumentScrollAnchor,
  completeDocumentScrollAnchorTop,
  type CompleteDocumentGeometry,
  type CompleteDocumentScrollAnchor,
} from "./geometry";

/** Preserve the visible source line when wrap, width, gutters or source text change.
 * Native size callbacks own scrollbar bounds; geometry owns measured rows and spacers.
 * Restore once those bounds match the plan, never on syntax arrival or ordinary scrolling.
 */
export function useDocumentScrollAnchor(
  scrollRef: MutableRefObject<ScrollBoxRenderable | null>,
  documentKey: string | null,
  geometry: CompleteDocumentGeometry,
  wrap: boolean,
) {
  const plan = useRef({ documentKey, geometry, wrap });
  const pending = useRef<CompleteDocumentScrollAnchor | null>(null);
  const apply = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let updatingBounds = false;

    /** Apply only after native content and scrollbar sizes agree with the measured extent. */
    const restore = () => {
      const anchor = pending.current;
      const { geometry, wrap } = plan.current;
      if (
        !anchor ||
        scroll.content.height !== Math.max(geometry.totalHeight, scroll.viewport.height) ||
        scroll.content.width !== Math.max(geometry.width, scroll.viewport.width) ||
        scroll.verticalScrollBar.scrollSize !== scroll.content.height ||
        scroll.verticalScrollBar.viewportSize !== scroll.viewport.height ||
        scroll.horizontalScrollBar.scrollSize !== scroll.content.width ||
        scroll.horizontalScrollBar.viewportSize !== scroll.viewport.width
      )
        return;

      pending.current = null;
      scroll.scrollTo({
        x: wrap ? 0 : scroll.scrollLeft,
        y: completeDocumentScrollAnchorTop(geometry, anchor),
      });
    };

    /** Distinguish native bounds clamping from an intentional keyboard, wheel or scrollbar move. */
    const onScroll = () => {
      if (!updatingBounds) pending.current = null;
    };

    const previousContentSizeChange = scroll.content.onSizeChange;
    const previousViewportSizeChange = scroll.viewport.onSizeChange;

    /** Let OpenTUI update both bars before resolving the logical anchor against their new limits. */
    const onContentSizeChange = () => {
      updatingBounds = true;
      try {
        previousContentSizeChange?.call(scroll.content);
        restore();
      } finally {
        updatingBounds = false;
      }
    };

    /** Observe viewport bounds too: resizing can change the limits without changing content height. */
    const onViewportSizeChange = () => {
      updatingBounds = true;
      try {
        previousViewportSizeChange?.call(scroll.viewport);
        restore();
      } finally {
        updatingBounds = false;
      }
    };

    apply.current = restore;
    scroll.content.onSizeChange = onContentSizeChange;
    scroll.viewport.onSizeChange = onViewportSizeChange;
    scroll.verticalScrollBar.on("change", onScroll);
    return () => {
      apply.current = () => {};
      scroll.verticalScrollBar.off("change", onScroll);
      if (scroll.content.onSizeChange === onContentSizeChange)
        scroll.content.onSizeChange = previousContentSizeChange;
      if (scroll.viewport.onSizeChange === onViewportSizeChange)
        scroll.viewport.onSizeChange = previousViewportSizeChange;
    };
  }, [scrollRef]);

  useLayoutEffect(() => {
    const previous = plan.current;
    const scroll = scrollRef.current;
    if (previous.documentKey !== documentKey) {
      pending.current = null;
      scroll?.scrollTo(0);
    } else if (scroll && previous.geometry !== geometry) {
      // Carry the original logical anchor through scrollbar-adjusted width remeasurement.
      pending.current ??= completeDocumentScrollAnchor(previous.geometry, scroll.scrollTop);
    }
    plan.current = { documentKey, geometry, wrap };
    apply.current();
  }, [documentKey, geometry, wrap, scrollRef]);
}

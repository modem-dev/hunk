import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { AppTheme } from "../../themes";

const HIDE_DELAY_MS = 2000;
const SCROLLBAR_WIDTH = 1;
const MIN_THUMB_HEIGHT = 2;

/**
 * Imperative API the scrollbar exposes to its parent.
 *
 * Parents receive this object via the `apiRef` callback prop (see below) instead of a
 * React-style ref, because Solid has no `forwardRef`/`useImperativeHandle`.
 */
export interface VerticalScrollbarHandle {
  show: () => void;
}

interface VerticalScrollbarProps {
  scrollRef: {
    current: {
      scrollTop: number;
      scrollTo: (y: number) => void;
      viewport: { height: number };
    } | null;
  };
  contentHeight: number;
  theme: AppTheme;
  height: number;
  onActivity?: () => void;
  /**
   * Receives the imperative {@link VerticalScrollbarHandle} once the component mounts.
   *
   * Replaces the former React `forwardRef` + `useImperativeHandle` contract. The parent
   * supplies a callback (e.g. `apiRef={(api) => (scrollbarApi.current = api)}`) and calls
   * `scrollbarApi.current?.show()` to flash the scrollbar on scroll activity.
   */
  apiRef?: (api: VerticalScrollbarHandle) => void;
}

/**
 * Auto-hiding vertical scrollbar overlay for a scrollbox.
 *
 * Renders a draggable thumb plus a clickable track and flashes itself visible whenever the
 * parent reports scroll activity through the {@link VerticalScrollbarHandle.show} method.
 */
export function VerticalScrollbar(props: VerticalScrollbarProps) {
  const [isVisible, setIsVisible] = createSignal(false);
  const [isDraggingState, setIsDraggingState] = createSignal(false);
  // Refs become plain mutable containers (no reactivity needed for drag bookkeeping).
  const isDraggingRef = { current: false };
  const dragStartYRef = { current: 0 };
  const dragStartScrollRef = { current: 0 };
  const hideTimeoutRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };

  /** Flash the scrollbar visible and (re)arm the auto-hide timer. */
  const show = () => {
    setIsVisible(true);
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    hideTimeoutRef.current = setTimeout(() => {
      if (!isDraggingRef.current) {
        setIsVisible(false);
      }
    }, HIDE_DELAY_MS);
    props.onActivity?.();
  };

  // Hand the imperative API to the parent once mounted, and clear any pending hide timer on
  // unmount so the timeout cannot fire after the component is gone.
  onMount(() => {
    props.apiRef?.({ show });
  });
  onCleanup(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
  });

  // Don't show if content fits in viewport
  const viewportHeight = () => props.height;
  const shouldShow = () => props.contentHeight > viewportHeight() && isVisible();

  // Calculate thumb metrics
  const trackHeight = () => viewportHeight();
  const scrollRatio = () => viewportHeight() / props.contentHeight;
  const thumbHeight = () => Math.max(MIN_THUMB_HEIGHT, Math.floor(trackHeight() * scrollRatio()));
  const maxThumbY = () => trackHeight() - thumbHeight();

  const scrollTop = () => props.scrollRef.current?.scrollTop ?? 0;
  const maxScroll = () => props.contentHeight - viewportHeight();
  const scrollPercent = () => (maxScroll() > 0 ? scrollTop() / maxScroll() : 0);
  const thumbY = () => Math.floor(scrollPercent() * maxThumbY());

  const handleMouseDown = (event: TuiMouseEvent) => {
    if (event.button !== 0) return;

    const currentScrollTop = props.scrollRef.current?.scrollTop ?? 0;
    isDraggingRef.current = true;
    setIsDraggingState(true);
    dragStartYRef.current = event.y;
    dragStartScrollRef.current = currentScrollTop;
    show();
    event.preventDefault();
    event.stopPropagation();
  };

  const handleMouseDrag = (event: TuiMouseEvent) => {
    if (!isDraggingRef.current) {
      return;
    }

    const deltaY = event.y - dragStartYRef.current;
    // Guard against division by zero when thumb fills track (maxThumbY = 0) or no scroll needed
    const pixelsPerRow = maxThumbY() > 0 && maxScroll() > 0 ? maxThumbY() / maxScroll() : 1;
    const scrollDelta = deltaY / pixelsPerRow;
    const newScrollTop = Math.max(
      0,
      Math.min(maxScroll(), dragStartScrollRef.current + scrollDelta),
    );

    props.scrollRef.current?.scrollTo(newScrollTop);
    show();
    event.preventDefault();
    event.stopPropagation();
  };

  const handleTrackClick = (event: TuiMouseEvent) => {
    if (event.button !== 0) return;

    // Calculate where on the track was clicked
    // Note: event.y is relative to the scrollbar container since the component
    // is positioned at top: 0. If scrollbar position changes, this needs adjustment.
    const clickY = event.y;

    // If clicked above thumb, scroll up one viewport
    // If clicked below thumb, scroll down one viewport
    if (clickY < thumbY()) {
      const newScrollTop = Math.max(0, scrollTop() - viewportHeight());
      props.scrollRef.current?.scrollTo(newScrollTop);
    } else if (clickY >= thumbY() + thumbHeight()) {
      const newScrollTop = Math.min(maxScroll(), scrollTop() + viewportHeight());
      props.scrollRef.current?.scrollTo(newScrollTop);
    }

    show();
    event.preventDefault();
    event.stopPropagation();
  };

  const handleMouseUp = (event?: TuiMouseEvent) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDraggingState(false);
    // Restart hide timer
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    hideTimeoutRef.current = setTimeout(() => {
      setIsVisible(false);
    }, HIDE_DELAY_MS);
    event?.preventDefault();
    event?.stopPropagation();
  };

  return (
    <Show when={shouldShow()}>
      <box
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: SCROLLBAR_WIDTH,
          height: trackHeight(),
          backgroundColor: props.theme.panel,
          zIndex: 2,
        }}
      >
        {/* Track background */}
        <box
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: SCROLLBAR_WIDTH,
            height: trackHeight(),
            backgroundColor: props.theme.border,
          }}
          onMouseDown={handleTrackClick}
        />
        {/* Thumb */}
        <box
          style={{
            position: "absolute",
            top: thumbY(),
            left: 0,
            width: SCROLLBAR_WIDTH,
            height: thumbHeight(),
            backgroundColor: isDraggingState() ? props.theme.accent : props.theme.accentMuted,
          }}
          onMouseDown={handleMouseDown}
          onMouseDrag={handleMouseDrag}
          onMouseUp={handleMouseUp}
          onMouseDragEnd={handleMouseUp}
        />
      </box>
    </Show>
  );
}

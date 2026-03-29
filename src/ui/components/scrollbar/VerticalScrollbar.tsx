import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { AppTheme } from "../../themes";

const HIDE_DELAY_MS = 2000;
const SCROLLBAR_WIDTH = 1;
const MIN_THUMB_HEIGHT = 2;

export interface VerticalScrollbarHandle {
  show: () => void;
}

interface VerticalScrollbarProps {
  scrollRef: RefObject<{
    scrollTop: number;
    scrollTo: (y: number) => void;
    viewport: { height: number };
  } | null>;
  contentHeight: number;
  theme: AppTheme;
  height: number;
  onActivity?: () => void;
}

export const VerticalScrollbar = forwardRef<VerticalScrollbarHandle, VerticalScrollbarProps>(
  function VerticalScrollbar({ scrollRef, contentHeight, theme, height, onActivity }, ref) {
    const [isVisible, setIsVisible] = useState(false);
    const [isDraggingState, setIsDraggingState] = useState(false);
    const isDraggingRef = useRef(false);
    const dragStartYRef = useRef(0);
    const dragStartScrollRef = useRef(0);
    const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const show = useCallback(() => {
      setIsVisible(true);
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
      hideTimeoutRef.current = setTimeout(() => {
        if (!isDraggingRef.current) {
          setIsVisible(false);
        }
      }, HIDE_DELAY_MS);
      onActivity?.();
    }, [onActivity]);

    useImperativeHandle(ref, () => ({ show }), [show]);

    useEffect(() => {
      return () => {
        if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current);
        }
      };
    }, []);

    // Don't show if content fits in viewport
    const viewportHeight = height;
    const shouldShow = contentHeight > viewportHeight && isVisible;

    // Calculate thumb metrics
    const trackHeight = viewportHeight;
    const scrollRatio = viewportHeight / contentHeight;
    const thumbHeight = Math.max(MIN_THUMB_HEIGHT, Math.floor(trackHeight * scrollRatio));
    const maxThumbY = trackHeight - thumbHeight;

    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    const maxScroll = contentHeight - viewportHeight;
    const scrollPercent = maxScroll > 0 ? scrollTop / maxScroll : 0;
    const thumbY = Math.floor(scrollPercent * maxThumbY);

    const handleMouseDown = (event: TuiMouseEvent) => {
      if (event.button !== 0) return;

      const currentScrollTop = scrollRef.current?.scrollTop ?? 0;
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
      const pixelsPerRow = maxThumbY > 0 && maxScroll > 0 ? maxThumbY / maxScroll : 1;
      const scrollDelta = deltaY / pixelsPerRow;
      const newScrollTop = Math.max(
        0,
        Math.min(maxScroll, dragStartScrollRef.current + scrollDelta),
      );

      scrollRef.current?.scrollTo(newScrollTop);
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
      if (clickY < thumbY) {
        const newScrollTop = Math.max(0, scrollTop - viewportHeight);
        scrollRef.current?.scrollTo(newScrollTop);
      } else if (clickY >= thumbY + thumbHeight) {
        const newScrollTop = Math.min(maxScroll, scrollTop + viewportHeight);
        scrollRef.current?.scrollTo(newScrollTop);
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

    if (!shouldShow) {
      return null;
    }

    return (
      <box
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: SCROLLBAR_WIDTH,
          height: trackHeight,
          backgroundColor: theme.panel,
        }}
      >
        {/* Track background */}
        <box
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: SCROLLBAR_WIDTH,
            height: trackHeight,
            backgroundColor: theme.border,
          }}
          onMouseDown={handleTrackClick}
        />
        {/* Thumb */}
        <box
          style={{
            position: "absolute",
            top: thumbY,
            left: 0,
            width: SCROLLBAR_WIDTH,
            height: thumbHeight,
            backgroundColor: isDraggingState ? theme.accent : theme.accentMuted,
          }}
          onMouseDown={handleMouseDown}
          onMouseDrag={handleMouseDrag}
          onMouseUp={handleMouseUp}
          onMouseDragEnd={handleMouseUp}
        />
      </box>
    );
  },
);

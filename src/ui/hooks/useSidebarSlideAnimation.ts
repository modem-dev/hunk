/**
 * Animates explicit files-sidebar visibility changes while semantic pane planning remains immediate.
 *
 * The hook retains an exiting files pane only in its presentation projection and moves review
 * geometry in the same timeline. Terminal resize, pane resize, registration changes, and the first
 * mounted layout snap directly to the semantic plan.
 */

import { useTimeline } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ExtensionPaneLayoutPlan } from "../lib/extensionPanes";
import {
  interpolateSidebarLayout,
  isSidebarVisibilityTransition,
  sidebarSlideAnimationDuration,
} from "../lib/sidebarSlide";

interface SidebarSlideAnimationOptions {
  bodyHeight: number;
  bodyWidth: number;
  filesPaneKey: string;
  paneLayout: ExtensionPaneLayoutPlan;
  resizing: boolean;
}

interface LayoutSnapshot {
  bodyHeight: number;
  bodyWidth: number;
  filesPaneKey: string;
  paneLayout: ExtensionPaneLayoutPlan;
}

interface ActiveTransition {
  from: ExtensionPaneLayoutPlan;
  to: ExtensionPaneLayoutPlan;
  filesPaneKey: string;
}

/** Return the presentation pane plan for the current sidebar slide frame. */
export function useSidebarSlideAnimation({
  bodyHeight,
  bodyWidth,
  filesPaneKey,
  paneLayout,
  resizing,
}: SidebarSlideAnimationOptions): ExtensionPaneLayoutPlan {
  const duration = sidebarSlideAnimationDuration();
  const timeline = useTimeline({
    autoplay: false,
    duration: Math.max(1, duration),
  });
  const [presentedLayout, setPresentedLayout] = useState(paneLayout);
  const presentedLayoutRef = useRef(paneLayout);
  const semanticSnapshotRef = useRef<LayoutSnapshot | null>(null);
  const activeTransitionRef = useRef<ActiveTransition | null>(null);
  const timelineConfiguredRef = useRef(false);

  useLayoutEffect(() => {
    if (timelineConfiguredRef.current) return;
    timelineConfiguredRef.current = true;
    timeline.add(
      { progress: 0 },
      {
        progress: 1,
        duration,
        ease: "outCirc",
        onUpdate: (animation) => {
          const transition = activeTransitionRef.current;
          if (!transition) return;
          const nextLayout = interpolateSidebarLayout(
            transition.from,
            transition.to,
            transition.filesPaneKey,
            animation.progress,
          );
          presentedLayoutRef.current = nextLayout;
          setPresentedLayout(nextLayout);
        },
        onComplete: () => {
          const transition = activeTransitionRef.current;
          if (!transition) return;
          activeTransitionRef.current = null;
          presentedLayoutRef.current = transition.to;
          setPresentedLayout(transition.to);
        },
      },
    );
  }, [duration, timeline]);

  useLayoutEffect(() => {
    const previous = semanticSnapshotRef.current;
    semanticSnapshotRef.current = { bodyHeight, bodyWidth, filesPaneKey, paneLayout };

    const canAnimate =
      previous !== null &&
      !resizing &&
      previous.bodyHeight === bodyHeight &&
      previous.bodyWidth === bodyWidth &&
      previous.filesPaneKey === filesPaneKey &&
      isSidebarVisibilityTransition(previous.paneLayout, paneLayout, filesPaneKey);

    if (!canAnimate) {
      activeTransitionRef.current = null;
      timeline.pause();
      presentedLayoutRef.current = paneLayout;
      setPresentedLayout(paneLayout);
      return;
    }

    activeTransitionRef.current = {
      from: presentedLayoutRef.current,
      to: paneLayout,
      filesPaneKey,
    };
    timeline.restart();
  }, [bodyHeight, bodyWidth, filesPaneKey, paneLayout, resizing, timeline]);

  return presentedLayout;
}

/**
 * Animates one pane visibility change while semantic pane planning remains immediate.
 *
 * The hook retains an exiting pane only in its presentation projection and moves the other panes
 * and review geometry in the same timeline. Terminal resize, pane resize, broader registration
 * changes, and the first mounted layout snap directly to the semantic plan.
 */

import { useTimeline } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ExtensionPaneLayoutPlan } from "../lib/extensionPanes";
import {
  interpolatePaneLayout,
  paneLayoutGeometryEqual,
  paneSlideAnimationDuration,
  paneVisibilityTransitionKey,
} from "../lib/paneSlide";

interface PaneSlideAnimationOptions {
  bodyHeight: number;
  bodyWidth: number;
  paneLayout: ExtensionPaneLayoutPlan;
  resizing: boolean;
}

interface LayoutSnapshot {
  bodyHeight: number;
  bodyWidth: number;
  paneLayout: ExtensionPaneLayoutPlan;
}

interface ActiveTransition {
  from: ExtensionPaneLayoutPlan;
  to: ExtensionPaneLayoutPlan;
  paneKey: string;
}

interface PaneSlidePresentation {
  animating: boolean;
  layout: ExtensionPaneLayoutPlan;
}

/** Return the presentation pane plan and whether its geometry is still moving. */
export function usePaneSlideAnimation({
  bodyHeight,
  bodyWidth,
  paneLayout,
  resizing,
}: PaneSlideAnimationOptions): PaneSlidePresentation {
  const duration = paneSlideAnimationDuration();
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
        ease: "outQuad",
        onUpdate: (animation) => {
          const transition = activeTransitionRef.current;
          if (!transition) return;
          const nextLayout = interpolatePaneLayout(
            transition.from,
            transition.to,
            transition.paneKey,
            animation.progress,
          );
          if (paneLayoutGeometryEqual(presentedLayoutRef.current, nextLayout)) return;
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
    semanticSnapshotRef.current = { bodyHeight, bodyWidth, paneLayout };
    const transitionKey = previous
      ? paneVisibilityTransitionKey(previous.paneLayout, paneLayout)
      : null;
    const interruptedByAnotherPane =
      activeTransitionRef.current !== null && activeTransitionRef.current.paneKey !== transitionKey;
    const canAnimate =
      previous !== null &&
      transitionKey !== null &&
      !interruptedByAnotherPane &&
      !resizing &&
      previous.bodyHeight === bodyHeight &&
      previous.bodyWidth === bodyWidth;

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
      paneKey: transitionKey,
    };
    timeline.restart();
  }, [bodyHeight, bodyWidth, paneLayout, resizing, timeline]);

  return {
    animating: activeTransitionRef.current !== null,
    layout: presentedLayout,
  };
}

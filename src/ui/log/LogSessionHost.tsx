import { useCallback, useEffect, useRef, useState } from "react";
import { retireExtensionLoadResult } from "../../extensions/events";
import { resolveStartupUpdateNotice } from "../../core/process/updateNotice";
import type { HistoryRuntime } from "../history/types";
import { AppHost } from "../AppHost";
import {
  createReviewSessionRuntime,
  prepareEmbeddedHistoryReview,
  type EmbeddedHistoryReview,
  type ReviewSessionRuntime,
} from "../runInteractiveApp";
import { interactiveLogUsesColor } from "./colorPolicy";
import { LogApp, type LogAppOutcome } from "./LogApp";
import { LogController } from "./controller";

interface MountedReview {
  plan: EmbeddedHistoryReview;
  runtime: ReviewSessionRuntime;
  instanceId: number;
}

/** Route history and fresh review sessions through one stable React and terminal renderer root. */
export function LogSessionHost({
  controller,
  runtime,
  externalQuitSignal,
  onQuit,
}: {
  controller: LogController;
  runtime: HistoryRuntime;
  externalQuitSignal: AbortSignal;
  onQuit: (exitCode?: number) => void;
}) {
  const [review, setReview] = useState<MountedReview | null>(null);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(preparing);
  preparingRef.current = preparing;
  const nextInstanceRef = useRef(1);

  const retireReview = useCallback(() => {
    const current = reviewRef.current;
    if (!current) return;
    reviewRef.current = null;
    current.runtime.stop();
    setReview(null);
    if (externalQuitSignal.aborted) onQuit();
  }, [externalQuitSignal, onQuit]);

  const handleLogOutcome = async (outcome: LogAppOutcome) => {
    if (outcome.kind === "quit") {
      onQuit(outcome.exitCode);
      return;
    }
    if (preparingRef.current || reviewRef.current) return;
    preparingRef.current = true;
    setPreparing(true);
    let plan: EmbeddedHistoryReview | undefined;
    try {
      plan = await prepareEmbeddedHistoryReview(runtime, outcome.action, {
        themeId: outcome.themeId,
        themeMode: outcome.themeMode,
        signal: externalQuitSignal,
      });
      externalQuitSignal.throwIfAborted();
      const reviewRuntime = createReviewSessionRuntime(
        plan.bootstrap,
        runtime.startupCwd ?? runtime.repoRoot,
      );
      const mounted = {
        plan,
        runtime: reviewRuntime,
        instanceId: nextInstanceRef.current++,
      } satisfies MountedReview;
      reviewRef.current = mounted;
      setReview(mounted);
    } catch (error) {
      if (plan && !reviewRef.current) {
        await retireExtensionLoadResult(plan.bootstrap.extensions);
      }
      if (externalQuitSignal.aborted) onQuit();
      else throw error;
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  };

  useEffect(() => {
    if (reviewRef.current || preparing) return;
    const requestQuit = () => onQuit();
    if (externalQuitSignal.aborted) requestQuit();
    else externalQuitSignal.addEventListener("abort", requestQuit, { once: true });
    return () => externalQuitSignal.removeEventListener("abort", requestQuit);
  }, [externalQuitSignal, onQuit, preparing, review]);

  if (review) {
    return (
      <AppHost
        key={review.instanceId}
        bootstrap={review.plan.bootstrap}
        externalQuitSignal={externalQuitSignal}
        hostClient={review.runtime.hostClient}
        onQuit={retireReview}
        onFirstFrameReady={() => undefined}
        returnToHistory
        reviewProducer={review.runtime.reviewProducer}
        startupNoticeResolver={resolveStartupUpdateNotice}
      />
    );
  }

  return (
    <LogApp
      controller={controller}
      runtime={runtime}
      useColor={interactiveLogUsesColor(runtime.input.color, process.env)}
      onOutcome={handleLogOutcome}
    />
  );
}

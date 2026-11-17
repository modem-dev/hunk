/** @jsxImportSource react */
/**
 * Shows the toolbar's viewed progress over the files the shared filter leaves visible: a
 * small ring and a compact "2/47 viewed" for the eye, and the full sentence ("2 of 47
 * viewed") for assistive technology, announced politely as marks change.
 *
 * Progress counts the session's viewed marks, which every surface shares. Hiding viewed files
 * is this browser's choice and lives in the View menu.
 */
import { formatReviewViewedProgress } from "../viewed/viewedFiles";

export interface ViewedProgressProps {
  progress: { viewed: number; total: number };
}

/** The ring's radius on the 16px icon grid, and so its circumference. */
const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Viewed progress as a ring and a count. */
export function ViewedProgress({ progress }: ViewedProgressProps) {
  const sentence = formatReviewViewedProgress(progress);
  const fraction = progress.total > 0 ? Math.min(1, progress.viewed / progress.total) : 0;

  return (
    <div className="viewed-progress" title={sentence.replace(" viewed", " files viewed")}>
      <svg className="progress-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="progress-ring-track" cx="8" cy="8" r={RING_RADIUS} />
        {fraction > 0 ? (
          <circle
            className="progress-ring-value"
            cx="8"
            cy="8"
            r={RING_RADIUS}
            strokeDasharray={`${fraction * RING_LENGTH} ${RING_LENGTH}`}
          />
        ) : null}
      </svg>
      <span className="viewed-count" aria-hidden="true">
        {`${progress.viewed}/${progress.total}`}
        <span className="viewed-word"> viewed</span>
      </span>
      <span className="visually-hidden" data-testid="viewed-progress" aria-live="polite">
        {sentence}
      </span>
    </div>
  );
}

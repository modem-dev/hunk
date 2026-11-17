/** @jsxImportSource react */
/**
 * Shows the review bar's viewed progress over the files the shared filter leaves visible: a
 * thin track filled in the theme's added color and the sentence "2 of 47 viewed", announced
 * politely as marks change.
 *
 * Progress counts the session's viewed marks, which every surface shares. Hiding viewed files
 * is this browser's choice and lives in the View menu.
 */
import { formatReviewViewedProgress } from "../viewed/viewedFiles";

export interface ViewedProgressProps {
  progress: { viewed: number; total: number };
}

/** Viewed progress as a track and a count. */
export function ViewedProgress({ progress }: ViewedProgressProps) {
  const sentence = formatReviewViewedProgress(progress);
  const fraction = progress.total > 0 ? Math.min(1, progress.viewed / progress.total) : 0;

  return (
    <div className="viewed-progress" title={sentence.replace(" viewed", " files viewed")}>
      <span className="progress-track" aria-hidden="true">
        <span className="progress-fill" style={{ width: `${fraction * 100}%` }} />
      </span>
      <span className="viewed-count" data-testid="viewed-progress" aria-live="polite">
        {sentence}
      </span>
    </div>
  );
}

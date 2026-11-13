/** @jsxImportSource react */
/**
 * The toolbar's viewed-files controls: progress ("12 of 47 viewed") over the files the shared
 * filter leaves visible, and the per-browser "Hide viewed" toggle.
 *
 * Progress counts the session's viewed marks, which every surface shares; hiding viewed files
 * is this browser's choice and never reaches the session.
 */
import { formatReviewViewedProgress } from "../viewed/viewedFiles";

export interface ViewedControlsProps {
  progress: { viewed: number; total: number };
  hideViewed: boolean;
  onToggleHideViewed: () => void;
}

/** Viewed progress and the "Hide viewed" toggle. */
export function ViewedControls({ progress, hideViewed, onToggleHideViewed }: ViewedControlsProps) {
  return (
    <div className="viewed-controls">
      <span className="viewed-progress" data-testid="viewed-progress" aria-live="polite">
        {formatReviewViewedProgress(progress)}
      </span>
      <button
        type="button"
        className="tool-button"
        aria-pressed={hideViewed}
        title="Hide viewed files in this browser; the marks stay shared"
        onClick={onToggleHideViewed}
      >
        Hide viewed
      </button>
    </div>
  );
}

/** @jsxImportSource react */
/**
 * The toolbar's review controls: the shared file filter, refresh, and "Copy review link".
 *
 * The filter and agent-note visibility are shared with every surface of the review, the
 * terminal included, so the filter says so beside itself. Refresh reopens the session's input
 * (`POST /refresh`), paced by the session. Copying the review link is the one deliberate way the
 * capability leaves the page.
 */
import { forwardRef, useState } from "react";

export interface ReviewControlsProps {
  filterText: string;
  onFilterChange: (text: string) => void;
  /** The shortcut that focuses the filter, for its tooltip. */
  filterKeyHint?: string;
  refreshing: boolean;
  onRefresh: () => void;
  refreshKeyHint?: string;
  onCopyLink: () => Promise<boolean>;
}

/** The filter field, refresh button, and copy-link button. */
export const ReviewControls = forwardRef<HTMLInputElement, ReviewControlsProps>(
  function ReviewControls(props, filterRef) {
    const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
    return (
      <div className="review-controls">
        <label
          className="filter-field"
          title="The filter is shared with the terminal and every other window on this review."
        >
          <span className="visually-hidden">Filter files</span>
          <input
            ref={filterRef}
            type="search"
            data-testid="filter-input"
            placeholder={`Filter files${props.filterKeyHint ? ` (${props.filterKeyHint})` : ""}`}
            value={props.filterText}
            onChange={(event) => props.onFilterChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
          <span className="shared-hint" aria-hidden="true">
            shared
          </span>
        </label>
        <button
          type="button"
          className="tool-button"
          data-testid="refresh"
          aria-busy={props.refreshing}
          disabled={props.refreshing}
          title={
            props.refreshKeyHint
              ? `Reload the review's input (${props.refreshKeyHint})`
              : "Reload the review's input"
          }
          onClick={props.onRefresh}
        >
          {props.refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          className="tool-button"
          data-testid="copy-link"
          title="Copy a link that opens this review, including its access key"
          onClick={async () => {
            setCopied((await props.onCopyLink()) ? "copied" : "failed");
            setTimeout(() => setCopied("idle"), 2_000);
          }}
        >
          {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy link"}
        </button>
      </div>
    );
  },
);

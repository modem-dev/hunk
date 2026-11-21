/** @jsxImportSource react */
/**
 * The toolbar's review controls: the shared file filter, refresh, and "Copy review link".
 *
 * The filter is shared with every surface of the review, the terminal included, so the field
 * says so beside itself and in its tooltip. Refresh reopens the session's input
 * (`POST /refresh`), paced by the session. Copying the review link is the one deliberate way
 * the capability leaves the page. Refresh and copy are icon buttons whose accessible names
 * carry their state ("Refreshing…", "Copied", "Copy failed"), and the copy result also shows
 * as a brief visible label.
 */
import { forwardRef, useState } from "react";
import { Icon } from "../icons/Icon";

export interface FilterFieldProps {
  filterText: string;
  onFilterChange: (text: string) => void;
  /** The shortcut that focuses the filter, shown in the field and its tooltip. */
  filterKeyHint?: string;
  /** The session has ended: the filter needs it, so it is disabled. */
  sessionEnded?: boolean;
}

/** The shared file filter field. */
export const FilterField = forwardRef<HTMLInputElement, FilterFieldProps>(
  function FilterField(props, filterRef) {
    return (
      <label
        className="filter-field"
        title={`The filter is shared with the terminal and every other window on this review.${
          props.filterKeyHint ? ` Focus it with ${props.filterKeyHint}.` : ""
        }`}
      >
        <Icon name="search" className="filter-icon" />
        <span className="visually-hidden">Filter files</span>
        <input
          ref={filterRef}
          type="search"
          data-testid="filter-input"
          placeholder="Filter files"
          value={props.filterText}
          disabled={props.sessionEnded}
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
        {props.filterKeyHint ? (
          <kbd className="key-hint filter-key" aria-hidden="true">
            {props.filterKeyHint}
          </kbd>
        ) : null}
      </label>
    );
  },
);

export interface ReviewActionsProps {
  refreshing: boolean;
  onRefresh: () => void;
  refreshKeyHint?: string;
  onCopyLink: () => Promise<boolean>;
  /** The session has ended: refresh needs it, so it is disabled. */
  sessionEnded?: boolean;
}

/** The refresh and copy-link icon buttons. */
export function ReviewActions(props: ReviewActionsProps) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copyLabel =
    copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy link";

  return (
    <>
      <button
        type="button"
        className="tool-button icon-button"
        data-testid="refresh"
        aria-busy={props.refreshing}
        disabled={props.refreshing || props.sessionEnded}
        title={
          props.refreshKeyHint
            ? `Reload the review's input (${props.refreshKeyHint})`
            : "Reload the review's input"
        }
        onClick={props.onRefresh}
      >
        <Icon name="refresh" className={props.refreshing ? "spinning" : undefined} />
        <span className="visually-hidden">{props.refreshing ? "Refreshing…" : "Refresh"}</span>
      </button>
      <button
        type="button"
        className="tool-button icon-button copy-button"
        data-testid="copy-link"
        data-state={copied}
        title="Copy a link that opens this review, including its access key"
        onClick={async () => {
          setCopied((await props.onCopyLink()) ? "copied" : "failed");
          setTimeout(() => setCopied("idle"), 2_000);
        }}
      >
        <Icon name={copied === "copied" ? "check" : copied === "failed" ? "cross" : "link"} />
        {/* The name doubles as the result: shown briefly after a copy, announced politely. */}
        <span
          className={copied === "idle" ? "visually-hidden" : "copy-feedback"}
          aria-live="polite"
        >
          {copyLabel}
        </span>
      </button>
    </>
  );
}

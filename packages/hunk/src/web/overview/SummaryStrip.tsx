/** @jsxImportSource react */
/**
 * The summary strip: one line above the review that says how big it is and what most of it is.
 *
 * It shows the Overview's size badge, one plain sentence when the changeset is mostly one file
 * or one directory (`./summarySentence.ts`), quiet role counts, and a button that opens the
 * side panel on its Overview tab. Every figure is `selectReviewOverview`'s over the files the
 * page shows, so with the shared filter active the strip counts the filtered files, as the
 * Overview tab does, and says so. The role counts are labels, not controls: the filter is
 * shared with the terminal, so nothing here changes it. Until the overview is ready the strip
 * reserves its height so the stream below does not jump.
 */
import { REVIEW_FILE_ROLES, type ReviewFileRole } from "../../core/review/fileRoles";
import type { ReviewOverview } from "../../core/review/overview";
import {
  formatAddedCount,
  formatCount,
  formatFileCount,
  formatRemovedCount,
} from "../format/lineCounts";
import { SIZE_BADGE_TITLE, SIZE_LABELS } from "./sizeBadge";
import { selectSummarySentence, type SummarySentence } from "./summarySentence";

/** What the strip says about an active shared filter. */
export interface SummaryStripFilter {
  text: string;
  /** Files the filter keeps, and files the review holds before it. */
  shown: number;
  total: number;
}

export interface SummaryStripProps {
  /** Absent while the review is still loading. */
  overview: ReviewOverview | undefined;
  filter?: SummaryStripFilter;
  /** Open the side panel on its Overview tab. */
  onOpenOverview: () => void;
  /** The keymap's chord for the show-overview command, when it has one. */
  overviewHint?: string;
}

const ROLE_WORDS: Record<ReviewFileRole, string> = {
  source: "source",
  test: "tests",
  docs: "docs",
  generated: "generated",
  config: "config",
};

/** A signed `+A −D` pair as two colored spans. */
function Churn({
  additions,
  deletions,
  truncated = false,
}: {
  additions: number;
  deletions: number;
  truncated?: boolean;
}) {
  return (
    <>
      <span className="stat-added">{formatAddedCount(additions, truncated)}</span>{" "}
      <span className="stat-removed">{formatRemovedCount(deletions)}</span>
    </>
  );
}

/** The sentence for one decided summary. */
function Sentence({ sentence }: { sentence: SummarySentence }) {
  if (sentence.kind === "directory") {
    return (
      <>
        {"Mostly in "}
        <code>{`${sentence.directory}/`}</code>
        {`: ${formatCount(sentence.files)} of ${formatCount(sentence.total)} files.`}
      </>
    );
  }
  return (
    <>
      {"Mostly "}
      <code>{sentence.path}</code> (<Churn {...sentence} />
      ).
      {sentence.rest ? (
        <>
          {` Without it: ${formatFileCount(sentence.rest.files)}, `}
          <Churn {...sentence.rest} />.
        </>
      ) : null}
    </>
  );
}

/** The summary strip. */
export function SummaryStrip({
  overview,
  filter,
  onOpenOverview,
  overviewHint,
}: SummaryStripProps) {
  if (!overview) {
    return <div className="summary-strip" data-testid="summary-strip" data-state="loading" />;
  }

  const sentence = selectSummarySentence(overview);
  const roles = REVIEW_FILE_ROLES.filter((role) => overview.roles[role].files > 0);
  const hasFiles = overview.totals.files > 0;

  return (
    <div className="summary-strip" data-testid="summary-strip" data-state="ready">
      {hasFiles ? (
        <span
          className="summary-size"
          data-size={overview.sizeClass}
          data-testid="summary-size"
          title={`${SIZE_LABELS[overview.sizeClass]}. ${SIZE_BADGE_TITLE}`}
        >
          {overview.sizeClass}
        </span>
      ) : null}
      <span className="summary-text" data-testid="summary-text">
        {filter ? (
          <span className="summary-filter" data-testid="summary-filter">
            {`Filtered: ${formatCount(filter.shown)} of ${formatFileCount(filter.total)}. `}
          </span>
        ) : null}
        {sentence ? <Sentence sentence={sentence} /> : null}
      </span>
      {roles.length > 0 ? (
        <ul className="summary-roles" aria-label="Files by role" data-testid="summary-roles">
          {roles.map((role) => (
            <li key={role} className="file-chip">
              {`${formatCount(overview.roles[role].files)} ${ROLE_WORDS[role]}`}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        className="summary-overview"
        data-testid="summary-overview"
        title={
          overviewHint ? `Show the review overview (${overviewHint})` : "Show the review overview"
        }
        onClick={onOpenOverview}
      >
        Overview
      </button>
    </div>
  );
}

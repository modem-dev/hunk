import { reviewFileStatBadges } from "../../core/review/presentation";
import type { DiffFile } from "../../core/types";
import { fileLabelParts } from "./files";
import { fitText, measureTextWidth } from "./text";

/** The explicit overflow marker used for file paths in review headers. */
export const FILE_HEADER_OVERFLOW_MARKER = "...";

/**
 * Build the styled text fragments and measured width for one file's line counts.
 *
 * The badge text is the shared review formatter's, so the diff header states the same
 * churn as the sidebar and a browser reading the same file (E1) — a zero count is absent
 * rather than printed as `+0`. Each present badge is trailed by one space, which is what
 * the header row draws and what the copied text has to reproduce cell for cell.
 */
export function fileHeaderStats(file: Pick<DiffFile, "stats" | "statsTruncated">) {
  const { additionsText, deletionsText } = reviewFileStatBadges({
    additions: file.stats.additions,
    deletions: file.stats.deletions,
    ...(file.statsTruncated !== undefined ? { truncated: file.statsTruncated } : {}),
  });
  const text = [additionsText, deletionsText]
    .filter((badge): badge is string => badge !== null)
    .map((badge) => `${badge} `)
    .join("");

  return {
    additionsText,
    deletionsText,
    text,
    width: measureTextWidth(text),
  };
}

/** Reserve only the columns needed by the widest visible file stats. */
export function maxFileHeaderStatsWidth(
  files: readonly Pick<DiffFile, "stats" | "statsTruncated">[],
) {
  return Math.max(0, ...files.map((file) => fileHeaderStats(file).width));
}

/** Fit a file label while keeping its state suffix and using an explicit three-dot marker. */
export function fitFileHeaderLabel(file: DiffFile, width: number) {
  const { filename, stateLabel } = fileLabelParts(file);
  const stateWidth = measureTextWidth(stateLabel ?? "");
  // The path is the primary identity. Drop a state suffix when it would leave
  // no path cell rather than letting the left column displace the stats.
  const visibleStateLabel = stateLabel && stateWidth < width ? stateLabel : null;
  const visibleStateWidth = visibleStateLabel ? stateWidth : 0;

  return {
    filename: fitText(
      filename,
      Math.max(0, width - visibleStateWidth),
      FILE_HEADER_OVERFLOW_MARKER,
    ),
    stateLabel: visibleStateLabel,
  };
}

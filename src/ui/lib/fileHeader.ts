import type { DiffFile } from "../../core/changeset/model";
import { fileLabelParts } from "./files";
import { fitText, measureTextWidth } from "./text";

/** The explicit overflow marker used for file paths in review headers. */
export const FILE_HEADER_OVERFLOW_MARKER = "...";

/** Build the styled text fragments and measured width for one file's line counts. */
export function fileHeaderStats(file: Pick<DiffFile, "stats" | "statsTruncated">) {
  const additionsText = `+${file.stats.additions}${file.statsTruncated ? "+" : ""}`;
  const deletionsText = `-${file.stats.deletions}`;
  const text = `${additionsText} ${deletionsText} `;

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

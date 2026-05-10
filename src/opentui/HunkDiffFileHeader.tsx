import { useMemo } from "react";
import { DiffFileHeaderRow } from "../ui/components/panes/DiffFileHeaderRow";
import { resolveTheme } from "../ui/themes";
import { toInternalDiffFile } from "./model";
import type { HunkDiffFileHeaderProps } from "./types";

/** Render Hunk's compact file header row for custom OpenTUI review layouts. */
export function HunkDiffFileHeader({
  file,
  width,
  theme = "graphite",
  onSelect,
}: HunkDiffFileHeaderProps) {
  const resolvedTheme = resolveTheme(theme, null);
  const internalFile = useMemo(() => toInternalDiffFile(file), [file]);
  const headerStatsWidth = Math.max(
    7,
    `+${internalFile.stats.additions}${internalFile.statsTruncated ? "+" : ""} -${internalFile.stats.deletions}`
      .length,
  );

  return (
    <DiffFileHeaderRow
      file={internalFile}
      headerLabelWidth={Math.max(1, width - headerStatsWidth - 2)}
      headerStatsWidth={headerStatsWidth}
      theme={resolvedTheme}
      onSelect={onSelect}
    />
  );
}

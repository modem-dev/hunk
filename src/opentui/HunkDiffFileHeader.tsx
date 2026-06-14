import { createMemo, mergeProps } from "solid-js";
import { DiffFileHeaderRow } from "../ui/components/panes/DiffFileHeaderRow";
import { resolveTheme } from "../ui/themes";
import { toInternalDiffFile } from "./model";
import type { HunkDiffFileHeaderProps } from "./types";

/** Render Hunk's compact file header row for custom OpenTUI review layouts. */
export function HunkDiffFileHeader(props: HunkDiffFileHeaderProps) {
  const merged = mergeProps({ theme: "graphite" as const }, props);
  const resolvedTheme = createMemo(() => resolveTheme(merged.theme, null));
  const internalFile = createMemo(() => toInternalDiffFile(merged.file));
  const headerStatsWidth = createMemo(() =>
    Math.max(
      7,
      `+${internalFile().stats.additions}${internalFile().statsTruncated ? "+" : ""} -${internalFile().stats.deletions}`
        .length,
    ),
  );

  return (
    <DiffFileHeaderRow
      file={internalFile()}
      headerLabelWidth={Math.max(1, merged.width - headerStatsWidth() - 2)}
      headerStatsWidth={headerStatsWidth()}
      theme={resolvedTheme()}
      onSelect={merged.onSelect}
    />
  );
}

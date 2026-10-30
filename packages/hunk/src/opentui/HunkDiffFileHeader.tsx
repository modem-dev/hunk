import { useMemo } from "react";
import { DiffFileHeaderRow } from "../ui/components/panes/DiffFileHeaderRow";
import { maxFileHeaderStatsWidth } from "../ui/lib/fileHeader";
import { resolveTheme } from "../ui/themes";
import { toInternalDiffFile } from "./model";
import type { HunkDiffFileHeaderProps } from "./types";

/** Render Hunk's compact file header row for custom OpenTUI review layouts. */
export function HunkDiffFileHeader({
  file,
  width,
  theme = "github-dark-default",
  onSelect,
}: HunkDiffFileHeaderProps) {
  const resolvedTheme = resolveTheme(theme, null);
  const internalFile = useMemo(() => toInternalDiffFile(file), [file]);
  const headerStatsWidth = maxFileHeaderStatsWidth([internalFile]);

  return (
    <DiffFileHeaderRow
      file={internalFile}
      headerLabelWidth={Math.max(0, width - 2 - headerStatsWidth - 1)}
      headerStatsWidth={headerStatsWidth}
      theme={resolvedTheme}
      onSelect={onSelect}
    />
  );
}

import type { FileDiffMetadata } from "@pierre/diffs";
import type { HunkDiffThemeName } from "./themes";

export type HunkDiffLayout = "split" | "stack";

/** Line stats shown by public Hunk OpenTUI primitives. */
export interface HunkDiffStats {
  additions: number;
  deletions: number;
}

/** Input accepted by public OpenTUI components before defaults are normalized. */
export interface HunkDiffFileInput {
  id: string;
  metadata: FileDiffMetadata;
  language?: string;
  path?: string;
  previousPath?: string;
  patch?: string;
  stats?: HunkDiffStats;
  isBinary?: boolean;
  isTooLarge?: boolean;
  isUntracked?: boolean;
  statsTruncated?: boolean;
}

/** Normalized diff file returned by createHunkDiffFile and patch helpers. */
export interface HunkDiffFile extends Omit<HunkDiffFileInput, "stats"> {
  stats: HunkDiffStats;
}

export interface HunkDiffSelection {
  fileId: string;
  hunkIndex: number;
}

/** Public props shared by single-file diff body and view components. */
export interface HunkDiffBodyProps {
  file?: HunkDiffFileInput;
  layout?: HunkDiffLayout;
  width: number;
  theme?: HunkDiffThemeName;
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  horizontalOffset?: number;
  highlight?: boolean;
  selectedHunkIndex?: number;
}

/** Public props for the reusable OpenTUI diff convenience component. */
export interface HunkDiffViewProps extends Omit<HunkDiffBodyProps, "file"> {
  diff?: HunkDiffFileInput;
  scrollable?: boolean;
}

export interface HunkDiffFileHeaderProps {
  file: HunkDiffFileInput;
  width: number;
  theme?: HunkDiffThemeName;
  onSelect?: () => void;
}

export interface HunkReviewStreamProps {
  files: HunkDiffFileInput[];
  layout?: HunkDiffLayout;
  width: number;
  theme?: HunkDiffThemeName;
  selection?: HunkDiffSelection;
  showFileHeaders?: boolean;
  showFileSeparators?: boolean;
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  horizontalOffset?: number;
  highlight?: boolean;
  onSelectionChange?: (selection: HunkDiffSelection) => void;
}

export interface HunkFileNavProps {
  files: HunkDiffFileInput[];
  selectedFileId?: string;
  width: number;
  theme?: HunkDiffThemeName;
  onSelectFile?: (fileId: string) => void;
}

import type { FileDiffMetadata } from "@pierre/diffs";
import type { HunkDiffThemeName } from "./themes";

export type HunkDiffLayout = "split" | "stack";

/** One diff file body that the exported OpenTUI component can render. */
export interface HunkDiffFile {
  id: string;
  metadata: FileDiffMetadata;
  language?: string;
  path?: string;
  patch?: string;
}

/** Public props for the reusable OpenTUI diff component. */
export interface HunkDiffViewProps {
  diff?: HunkDiffFile;
  layout?: HunkDiffLayout;
  width: number;
  theme?: HunkDiffThemeName;
  showLineNumbers?: boolean;
  showHunkHeaders?: boolean;
  wrapLines?: boolean;
  horizontalOffset?: number;
  highlight?: boolean;
  scrollable?: boolean;
  selectedHunkIndex?: number;
}

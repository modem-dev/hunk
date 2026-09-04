import type { HistoryCommandInput } from "../../core/run/commandInputs";
import type { VcsHistorySource } from "../../core/vcs/types";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsHistoryReviewAction,
  NamedCustomThemeConfig,
} from "../../extension-api/types";

/** Renderer-facing history resources, excluding app and extension ownership details. */
export interface HistoryRuntime {
  input: HistoryCommandInput;
  source: VcsHistorySource;
  providerId: string;
  providerName: string;
  repoRoot: string;
  notices: readonly string[];
  customThemes: readonly NamedCustomThemeConfig[];
  planReview(commit: ExtensionVcsHistoryCommit): Promise<ExtensionVcsHistoryReviewAction>;
  close(): Promise<void>;
}

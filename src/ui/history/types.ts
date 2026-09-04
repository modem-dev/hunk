import type { HistoryCommandInput } from "../../core/run/commandInputs";
import type { VcsHistorySource } from "../../core/vcs/types";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsHistoryReviewAction,
  ExtensionVcsHistoryReviewOptions,
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
  planReview(
    commit: ExtensionVcsHistoryCommit,
    options?: ExtensionVcsHistoryReviewOptions,
  ): Promise<ExtensionVcsHistoryReviewAction>;
  /** Replace the current provider cursor for an explicit interactive refresh. */
  reopenSource(signal?: AbortSignal): Promise<VcsHistorySource>;
  close(): Promise<void>;
}

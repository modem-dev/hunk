import type { HistoryCommandInput } from "../../core/run/commandInputs";
import type { VcsHistorySource } from "../../core/vcs/types";
import type { ExtensionSession } from "../../extensions/session";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsHistoryReviewAction,
  ExtensionVcsHistoryReviewOptions,
  NamedCustomThemeConfig,
} from "../../extension-api/types";

/** Renderer-facing history resources with cursor data and command-owned extension authority. */
export interface HistoryRuntime {
  input: HistoryCommandInput;
  source: VcsHistorySource;
  providerId: string;
  providerName: string;
  /** Invocation cwd used to resolve explicit extension paths for embedded reviews. */
  startupCwd?: string;
  repoRoot: string;
  notices: readonly string[];
  customThemes: readonly NamedCustomThemeConfig[];
  /** Command-owned extension authority borrowed by embedded reviews. */
  extensionSession: ExtensionSession;
  planReview(
    commit: ExtensionVcsHistoryCommit,
    options?: ExtensionVcsHistoryReviewOptions,
  ): Promise<ExtensionVcsHistoryReviewAction>;
  /** Replace the current provider cursor for an explicit interactive refresh. */
  reopenSource(signal?: AbortSignal): Promise<VcsHistorySource>;
  close(): Promise<void>;
}

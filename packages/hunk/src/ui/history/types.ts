import type { HistoryCommandInput } from "../../core/run/commandInputs";
import type { PersistedViewPreferences, UserKeyBinding } from "../../core/run/config";
import type { VcsHistorySource } from "../../core/vcs/types";
import type { ExtensionSession } from "../../extensions/session";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsHistoryRangeReviewAction,
  ExtensionVcsHistoryRangeSelection,
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
  /** User command overrides resolved by the active interactive surface. */
  keybindings: Readonly<Record<string, UserKeyBinding>>;
  /** Resolved launch preferences retained while history owns the session-wide quit flow. */
  initialViewPreferences: PersistedViewPreferences;
  viewPreferencesConfigPath?: string;
  promptSaveViewPreferences: boolean;
  /** Command-owned extension authority borrowed by embedded reviews. */
  extensionSession: ExtensionSession;
  planReview(
    commit: ExtensionVcsHistoryCommit,
    options?: ExtensionVcsHistoryReviewOptions,
    signal?: AbortSignal,
  ): Promise<ExtensionVcsHistoryReviewAction>;
  planRangeReview?(
    selection: ExtensionVcsHistoryRangeSelection,
    options?: ExtensionVcsHistoryReviewOptions,
    signal?: AbortSignal,
  ): Promise<ExtensionVcsHistoryRangeReviewAction>;
  /** Replace the current provider cursor for an explicit interactive refresh. */
  reopenSource(signal?: AbortSignal): Promise<VcsHistorySource>;
  close(): Promise<void>;
}

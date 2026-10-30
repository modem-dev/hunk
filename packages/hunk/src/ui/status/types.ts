import type { AppBootstrap } from "../../core/bootstrap";
import type { CliInput, CommonOptions, StatusCommandInput } from "../../core/run/commandInputs";
import type { PersistedViewPreferences, UserKeyBinding } from "../../core/run/config";
import type { InteractiveSessionInitialization } from "../../core/session/initialization";
import type {
  ExtensionVcsHistoryReviewAction,
  ExtensionVcsStatusCapability,
  ExtensionVcsStatusSnapshot,
} from "../../extension-api/types";
import type { ExtensionSession } from "../../extensions/session";
import type { ExtensionLoadResult } from "../../extensions/types";
import type { InteractiveHistoryRuntime } from "../history/types";

/** Describe status resources without giving the presentation layer startup or trust authority. */
export interface StatusRuntime {
  input: StatusCommandInput;
  snapshot: ExtensionVcsStatusSnapshot;
  providerId: string;
  providerName: string;
  startupCwd: string;
  launchOptions: CommonOptions;
  extensionSession: ExtensionSession;
  initialization: InteractiveSessionInitialization;
  keybindings: Readonly<Record<string, UserKeyBinding>>;
  initialViewPreferences: PersistedViewPreferences;
  viewPreferencesConfigPath?: string;
  promptSaveViewPreferences: boolean;
  notices: readonly string[];
  load(targetPath?: string, signal?: AbortSignal): Promise<ExtensionVcsStatusSnapshot>;
  loadSiblings(
    snapshot: ExtensionVcsStatusSnapshot,
    signal?: AbortSignal,
  ): Promise<ExtensionVcsStatusSnapshot>;
  planReview(
    snapshot: ExtensionVcsStatusSnapshot,
    actionId: string,
    signal?: AbortSignal,
  ): ReturnType<ExtensionVcsStatusCapability["planReview"]>;
  watchPlan(
    snapshot: ExtensionVcsStatusSnapshot,
    signal?: AbortSignal,
  ): ReturnType<NonNullable<ExtensionVcsStatusCapability["watchPlan"]>>;
  openHistory(targetPath: string, signal?: AbortSignal): Promise<InteractiveHistoryRuntime>;
  prepareReview(
    input: CliInput,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<AppBootstrap<ExtensionLoadResult>>;
  prepareHistoryReview(
    action: ExtensionVcsHistoryReviewAction,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<AppBootstrap<ExtensionLoadResult>>;
  close(): Promise<void>;
}

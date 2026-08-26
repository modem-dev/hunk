/**
 * Coordinates view-preference dirty state, persistence choices, prompt state, and safe delayed quits.
 * App continues to render the dialog and own its keyboard and UI composition.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  diffPersistedViewPreferences,
  saveGlobalViewPreferences,
  saveViewPreferencesPromptPreference,
  type PersistedViewPreferences,
  type ViewPreferenceChange,
} from "../../core/run/config";

const POST_PERSISTENCE_QUIT_DELAY_MS = 120;
const DEFAULT_VIEW_PREFERENCES_CONFIG_LABEL = "~/.config/hunk/config.toml";

/** Schedule and cancel the delayed quit that lets a persistence notice render. */
export interface ViewPreferenceQuitScheduler {
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

const DEFAULT_QUIT_SCHEDULER: ViewPreferenceQuitScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One aligned TOML row rendered by the view-preference confirmation dialog. */
export interface ViewPreferenceDiffLine {
  removed: boolean;
  text: string;
}

/** Dirty-state projection and quit actions consumed by App's existing UI composition. */
export interface ViewPreferenceQuitController {
  changedViewPreferences: ViewPreferenceChange[];
  saveConfigPromptOpen: boolean;
  viewPreferenceDiffLines: ViewPreferenceDiffLine[];
  viewPreferencesConfigLabel: string;
  requestQuit: () => void;
  saveViewPreferencesAndQuit: () => void;
  discardViewPreferencesAndQuit: () => void;
  neverAskToSaveViewPreferencesAndQuit: () => void;
  closeSaveConfigPrompt: () => void;
}

/** App-owned facts and side effects required by the view-preference quit workflow. */
export interface UseViewPreferenceQuitControllerOptions {
  currentPreferences: PersistedViewPreferences;
  configPath?: string;
  pagerMode: boolean;
  promptSaveViewPreferences: boolean;
  transientViewPreferences: boolean;
  onQuit: () => void;
  showNotice: (message: string) => void;
  showError: (message: string) => void;
  closeHelp: () => void;
  homeDirectory: string | undefined;
  quitScheduler?: ViewPreferenceQuitScheduler;
}

/** Build aligned TOML removal/addition rows in the core preference order. */
function buildViewPreferenceDiffLines(
  changes: readonly ViewPreferenceChange[],
): ViewPreferenceDiffLine[] {
  const keyWidth = changes.reduce((width, change) => Math.max(width, change.configKey.length), 0);
  return changes.flatMap((change) => [
    { removed: true, text: `- ${change.configKey.padEnd(keyWidth)} = ${change.previousValue}` },
    { removed: false, text: `+ ${change.configKey.padEnd(keyWidth)} = ${change.nextValue}` },
  ]);
}

/** Own view-preference dirty state and the save-or-discard quit workflow for one mounted App. */
export function useViewPreferenceQuitController({
  currentPreferences,
  configPath,
  pagerMode,
  promptSaveViewPreferences,
  transientViewPreferences,
  onQuit,
  showNotice,
  showError,
  closeHelp,
  homeDirectory,
  quitScheduler = DEFAULT_QUIT_SCHEDULER,
}: UseViewPreferenceQuitControllerOptions): ViewPreferenceQuitController {
  const [savedPreferences, setSavedPreferences] = useState(currentPreferences);
  const [saveConfigPromptOpen, setSaveConfigPromptOpen] = useState(false);
  const pendingQuitTimerRef = useRef<unknown>(undefined);
  const quitPendingRef = useRef(false);
  const changedViewPreferences = useMemo(
    () => diffPersistedViewPreferences(savedPreferences, currentPreferences),
    [currentPreferences, savedPreferences],
  );
  const viewPreferenceDiffLines = useMemo(
    () => buildViewPreferenceDiffLines(changedViewPreferences),
    [changedViewPreferences],
  );
  const hasUnsavedViewPreferences = changedViewPreferences.length > 0;
  const viewPreferencesConfigLabel = useMemo(() => {
    const path = configPath ?? DEFAULT_VIEW_PREFERENCES_CONFIG_LABEL;
    return homeDirectory && path.startsWith(homeDirectory)
      ? `~${path.slice(homeDirectory.length)}`
      : path;
  }, [configPath, homeDirectory]);

  /** Close the prompt, lock its actions, and schedule one delayed quit. */
  const scheduleQuit = useCallback(() => {
    if (quitPendingRef.current) return;

    quitPendingRef.current = true;
    setSaveConfigPromptOpen(false);
    pendingQuitTimerRef.current = quitScheduler.schedule(() => {
      pendingQuitTimerRef.current = undefined;
      quitPendingRef.current = false;
      onQuit();
    }, POST_PERSISTENCE_QUIT_DELAY_MS);
  }, [onQuit, quitScheduler]);

  useEffect(
    () => () => {
      if (!quitPendingRef.current) return;

      quitScheduler.cancel(pendingQuitTimerRef.current);
      pendingQuitTimerRef.current = undefined;
      quitPendingRef.current = false;
    },
    [quitScheduler],
  );

  /** Save current preferences, advance the dirty baseline, and leave after the notice is visible. */
  const saveViewPreferencesAndQuit = useCallback(() => {
    if (quitPendingRef.current) return;

    try {
      const savedPath = saveGlobalViewPreferences(currentPreferences, { configPath });
      setSavedPreferences(currentPreferences);
      showNotice(`Saved view preferences to ${savedPath}`);
      scheduleQuit();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Failed to save view preferences.");
    }
  }, [configPath, currentPreferences, scheduleQuit, showError, showNotice]);

  /** Leave without persisting either the current preferences or prompt policy. */
  const discardViewPreferencesAndQuit = useCallback(() => {
    if (quitPendingRef.current) return;

    setSaveConfigPromptOpen(false);
    onQuit();
  }, [onQuit]);

  /** Disable future prompts without persisting the changed view preferences, then leave. */
  const neverAskToSaveViewPreferencesAndQuit = useCallback(() => {
    if (quitPendingRef.current) return;

    try {
      const savedPath = saveViewPreferencesPromptPreference(false, { configPath });
      showNotice(`Won't ask to save view preferences again (${savedPath})`);
      scheduleQuit();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Failed to save prompt preference.");
    }
  }, [configPath, scheduleQuit, showError, showNotice]);

  /** Prompt for changed persistent preferences or leave immediately when prompting is inapplicable. */
  const requestQuit = useCallback(() => {
    if (quitPendingRef.current) return;

    if (
      !pagerMode &&
      !transientViewPreferences &&
      promptSaveViewPreferences &&
      hasUnsavedViewPreferences
    ) {
      closeHelp();
      setSaveConfigPromptOpen(true);
      return;
    }

    onQuit();
  }, [
    closeHelp,
    hasUnsavedViewPreferences,
    onQuit,
    pagerMode,
    promptSaveViewPreferences,
    transientViewPreferences,
  ]);

  /** Cancel the pending quit decision without changing preferences or their baseline. */
  const closeSaveConfigPrompt = useCallback(() => {
    if (quitPendingRef.current) return;

    setSaveConfigPromptOpen(false);
  }, []);

  return {
    changedViewPreferences,
    saveConfigPromptOpen,
    viewPreferenceDiffLines,
    viewPreferencesConfigLabel,
    requestQuit,
    saveViewPreferencesAndQuit,
    discardViewPreferencesAndQuit,
    neverAskToSaveViewPreferencesAndQuit,
    closeSaveConfigPrompt,
  };
}

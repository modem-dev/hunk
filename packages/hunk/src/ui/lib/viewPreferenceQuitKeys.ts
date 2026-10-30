import type { KeyEvent } from "@opentui/core";
import type { ViewPreferenceQuitController } from "../hooks/useViewPreferenceQuitController";
import { isEscapeKey } from "./keyboard";

type ViewPreferenceQuitPromptActions = Pick<
  ViewPreferenceQuitController,
  | "saveViewPreferencesAndQuit"
  | "discardViewPreferencesAndQuit"
  | "neverAskToSaveViewPreferencesAndQuit"
  | "closeSaveConfigPrompt"
>;

/** Dispatch one key owned by the save-view-preferences prompt. */
export function handleViewPreferenceQuitPromptKey(
  key: KeyEvent,
  actions: ViewPreferenceQuitPromptActions,
): void {
  if (key.name === "return" || key.name === "enter" || key.name === "s" || key.sequence === "s") {
    actions.saveViewPreferencesAndQuit();
    return;
  }

  // A repeated quit key discards, so double-tapping q always exits.
  if (key.name === "q" || key.sequence === "q") {
    actions.discardViewPreferencesAndQuit();
    return;
  }

  if (key.name === "n" || key.sequence === "n") {
    actions.neverAskToSaveViewPreferencesAndQuit();
    return;
  }

  if (isEscapeKey(key)) actions.closeSaveConfigPrompt();
}

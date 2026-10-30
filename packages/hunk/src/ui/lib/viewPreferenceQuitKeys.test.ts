import { describe, expect, mock, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { handleViewPreferenceQuitPromptKey } from "./viewPreferenceQuitKeys";

/** Build one minimal OpenTUI key event for prompt-dispatch tests. */
function key(name: string, sequence = ""): KeyEvent {
  return { name, sequence } as KeyEvent;
}

/** Build observable prompt actions without coupling tests to persistence. */
function actions() {
  return {
    saveViewPreferencesAndQuit: mock(() => undefined),
    discardViewPreferencesAndQuit: mock(() => undefined),
    neverAskToSaveViewPreferencesAndQuit: mock(() => undefined),
    closeSaveConfigPrompt: mock(() => undefined),
  };
}

describe("view preference quit prompt keys", () => {
  test.each([
    [key("return"), "saveViewPreferencesAndQuit"],
    [key("enter"), "saveViewPreferencesAndQuit"],
    [key("s"), "saveViewPreferencesAndQuit"],
    [key("unknown", "s"), "saveViewPreferencesAndQuit"],
    [key("q"), "discardViewPreferencesAndQuit"],
    [key("unknown", "q"), "discardViewPreferencesAndQuit"],
    [key("n"), "neverAskToSaveViewPreferencesAndQuit"],
    [key("unknown", "n"), "neverAskToSaveViewPreferencesAndQuit"],
    [key("escape"), "closeSaveConfigPrompt"],
  ] as const)("dispatches %o to %s", (input, expectedAction) => {
    const promptActions = actions();

    handleViewPreferenceQuitPromptKey(input, promptActions);

    expect(promptActions[expectedAction]).toHaveBeenCalledTimes(1);
    expect(
      Object.values(promptActions).reduce((count, action) => count + action.mock.calls.length, 0),
    ).toBe(1);
  });

  test("does nothing for an unrecognized key", () => {
    const promptActions = actions();

    handleViewPreferenceQuitPromptKey(key("x", "x"), promptActions);

    expect(Object.values(promptActions).every((action) => action.mock.calls.length === 0)).toBe(
      true,
    );
  });
});

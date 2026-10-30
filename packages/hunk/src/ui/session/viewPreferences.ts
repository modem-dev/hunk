import type { AppBootstrap } from "../../core/bootstrap";
import type { PersistedViewPreferences } from "../../core/run/config";

/** Seed a freshly prepared review from the preferences retained by its routed session. */
export function applySessionViewPreferences<ExtensionState>(
  bootstrap: AppBootstrap<ExtensionState>,
  preferences: PersistedViewPreferences,
): AppBootstrap<ExtensionState> {
  return {
    ...bootstrap,
    input: {
      ...bootstrap.input,
      options: {
        ...bootstrap.input.options,
        mode: preferences.mode,
        theme: preferences.theme,
        lineNumbers: preferences.showLineNumbers,
        wrapLines: preferences.wrapLines,
        hunkHeaders: preferences.showHunkHeaders,
        menuBar: preferences.showMenuBar,
        agentNotes: preferences.showAgentNotes,
        copyDecorations: preferences.copyDecorations,
        cursorLine: preferences.cursorLine,
      },
    },
    initialMode: preferences.mode,
    initialTheme: preferences.theme,
    initialShowLineNumbers: preferences.showLineNumbers,
    initialWrapLines: preferences.wrapLines,
    initialShowHunkHeaders: preferences.showHunkHeaders,
    initialShowMenuBar: preferences.showMenuBar,
    initialShowAgentNotes: preferences.showAgentNotes,
    initialCopyDecorations: preferences.copyDecorations,
    initialCursorLine: preferences.cursorLine,
  };
}

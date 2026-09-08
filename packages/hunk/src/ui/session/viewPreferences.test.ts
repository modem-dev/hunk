import { expect, test } from "bun:test";
import { createTestVcsAppBootstrap } from "../../../../../test/helpers/app-bootstrap";
import type { PersistedViewPreferences } from "../../core/run/config";
import { applySessionViewPreferences } from "./viewPreferences";

test("projects every retained view preference into a fresh review bootstrap", () => {
  const bootstrap = createTestVcsAppBootstrap({
    files: [],
    initialMode: "split",
    vcsOptions: { watch: true },
  });
  const preferences: PersistedViewPreferences = {
    mode: "unified",
    theme: "dracula",
    showLineNumbers: false,
    wrapLines: true,
    showHunkHeaders: false,
    showMenuBar: false,
    showAgentNotes: true,
    copyDecorations: true,
    cursorLine: "number",
  };

  const projected = applySessionViewPreferences(bootstrap, preferences);

  expect(projected).not.toBe(bootstrap);
  expect(projected.input.options).toEqual({
    agentNotes: true,
    copyDecorations: true,
    cursorLine: "number",
    hunkHeaders: false,
    lineNumbers: false,
    menuBar: false,
    mode: "unified",
    pager: false,
    theme: "dracula",
    watch: true,
    wrapLines: true,
  });
  expect(projected).toMatchObject({
    initialMode: "unified",
    initialTheme: "dracula",
    initialShowLineNumbers: false,
    initialWrapLines: true,
    initialShowHunkHeaders: false,
    initialShowMenuBar: false,
    initialShowAgentNotes: true,
    initialCopyDecorations: true,
    initialCursorLine: "number",
  });
  expect(bootstrap.initialMode).toBe("split");
});

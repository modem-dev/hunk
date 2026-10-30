import { describe, expect, test } from "bun:test";
import {
  HISTORY_COMMAND_CATALOG,
  HISTORY_COMMAND_NAMES,
  historyCommandCatalogEntry,
} from "./historyCommandCatalog";

/** Verify history command identity remains canonical and collision-free. */
describe("history command catalog", () => {
  test("uses canonical history ids except for deliberately shared commands", () => {
    const ids = HISTORY_COMMAND_CATALOG.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const command of HISTORY_COMMAND_CATALOG) {
      expect(command.id.startsWith(`hunk.${command.category}.`)).toBe(true);
      expect(command.title.length).toBeGreaterThan(0);
    }
    expect(ids).toContain("hunk.app.quit");
    expect(ids).toContain("hunk.app.toggleHelp");
    expect(ids).toContain("hunk.view.openThemeSelector");
    expect(ids).toContain("hunk.history.nextCommit");
    expect(historyCommandCatalogEntry("hunk.app.quit")?.defaultKeys).toEqual(["q", "ctrl+c"]);
  });

  test("publishes every canonical and compatibility name for cross-surface validation", () => {
    for (const command of HISTORY_COMMAND_CATALOG) {
      expect(HISTORY_COMMAND_NAMES.has(command.id)).toBe(true);
      expect(historyCommandCatalogEntry(command.id)).toBe(command);
      for (const alias of command.aliases ?? []) {
        expect(HISTORY_COMMAND_NAMES.has(alias)).toBe(true);
        expect(historyCommandCatalogEntry(alias)).toBe(command);
      }
    }
  });
});

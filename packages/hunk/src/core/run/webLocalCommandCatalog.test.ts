import { describe, expect, test } from "bun:test";
import { APP_COMMAND_NAMES } from "./commandCatalog";
import { DOCUMENT_COMMAND_NAMES } from "./documentCommandCatalog";
import { HISTORY_COMMAND_NAMES } from "./historyCommandCatalog";
import { STATUS_COMMAND_NAMES } from "./statusCommandCatalog";
import {
  WEB_LOCAL_COMMAND_KEY_DEFAULTS,
  WEB_LOCAL_COMMAND_NAMES,
  WEB_LOCAL_COMMANDS,
  WEB_LOCAL_FIXED_COMMAND_NAMES,
} from "./webLocalCommandCatalog";

describe("page command catalog", () => {
  test("keeps every id under hunk.web.* and out of every terminal surface's command set", () => {
    const terminalNames = new Set([
      ...APP_COMMAND_NAMES,
      ...DOCUMENT_COMMAND_NAMES,
      ...HISTORY_COMMAND_NAMES,
      ...STATUS_COMMAND_NAMES,
    ]);
    for (const command of WEB_LOCAL_COMMANDS) {
      expect(command.id.startsWith("hunk.web.")).toBe(true);
      expect([command.id, terminalNames.has(command.id)]).toEqual([command.id, false]);
    }
  });

  // Intent: every page command is either remappable or fixed, never both and never neither, so
  // a `[keybindings]` entry naming one always gets a definite answer.
  test("splits the commands into remappable and fixed with nothing left over", () => {
    const ids = WEB_LOCAL_COMMANDS.map((command) => command.id as string);
    expect([...WEB_LOCAL_COMMAND_NAMES, ...WEB_LOCAL_FIXED_COMMAND_NAMES].sort()).toEqual(
      [...ids].sort(),
    );
    for (const id of WEB_LOCAL_FIXED_COMMAND_NAMES) {
      expect(WEB_LOCAL_COMMAND_NAMES.has(id)).toBe(false);
    }
  });

  test("fixes exactly the commands that claim a Ctrl/Cmd chord from the browser", () => {
    const withModKey = WEB_LOCAL_COMMANDS.filter((command) => "modKey" in command).map(
      (command) => command.id as string,
    );
    expect([...WEB_LOCAL_FIXED_COMMAND_NAMES]).toEqual(withModKey);
  });

  test("carries each remappable command's shipped plain chords, or none when it ships unbound", () => {
    for (const command of WEB_LOCAL_COMMANDS) {
      if ("modKey" in command) continue;
      const defaults = WEB_LOCAL_COMMAND_KEY_DEFAULTS.find((entry) => entry.id === command.id);
      expect(defaults?.defaultKeys).toEqual("keys" in command ? [...command.keys] : []);
    }
  });
});

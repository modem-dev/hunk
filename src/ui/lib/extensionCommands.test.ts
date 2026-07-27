import { describe, expect, test } from "bun:test";
import type { RegisteredCommand } from "../../extensions/types";
import { synthesizeKeyEvent, parseKeyChord } from "../../lib/commandKeys";
import { builtinCommandMatchProbes, dispatchAppCommand } from "./appCommands";
import { buildExtensionAppCommands } from "./extensionCommands";

function registeredCommand(extensionId: string, id: string, key?: string): RegisteredCommand {
  return { extensionId, command: { id, title: id, key }, handler: () => {} };
}

function chordEvent(chord: string) {
  const parsed = parseKeyChord(chord);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }

  return synthesizeKeyEvent(parsed);
}

describe("buildExtensionAppCommands", () => {
  test("adapts bound commands into dispatchable review-scope entries", () => {
    const ran: string[] = [];
    const { commands, conflicts } = buildExtensionAppCommands({
      registered: [registeredCommand("meta", "toggle", "y"), registeredCommand("meta", "silent")],
      builtins: builtinCommandMatchProbes(),
      runCommand: (registered) => ran.push(`${registered.extensionId}.${registered.command.id}`),
    });

    expect(conflicts).toEqual([]);
    // The unbound command has nothing to dispatch; the bound one runs on its key.
    expect(commands.map((command) => command.id)).toEqual(["meta.toggle"]);
    expect(dispatchAppCommand(commands, "review", chordEvent("y"))?.id).toBe("meta.toggle");
    expect(ran).toEqual(["meta.toggle"]);
  });

  test("refuses chords owned by built-in shortcuts", () => {
    const { commands, conflicts } = buildExtensionAppCommands({
      // "s" toggles the sidebar and "[" is hunk navigation; both are taken.
      registered: [registeredCommand("meta", "steal-s", "s"), registeredCommand("meta", "ok", "y")],
      builtins: builtinCommandMatchProbes(),
      runCommand: () => {},
    });

    expect(commands.map((command) => command.id)).toEqual(["meta.ok"]);
    expect(conflicts).toEqual([
      {
        extensionId: "meta",
        fullId: "meta.steal-s",
        key: "s",
        conflictingId: "view.toggleSidebar",
      },
    ]);
  });

  test("resolves chords between extensions by load order", () => {
    const { commands, conflicts } = buildExtensionAppCommands({
      registered: [
        registeredCommand("first", "mine", "y"),
        registeredCommand("second", "mine", "y"),
      ],
      builtins: builtinCommandMatchProbes(),
      runCommand: () => {},
    });

    expect(commands.map((command) => command.id)).toEqual(["first.mine"]);
    expect(conflicts.map((conflict) => conflict.fullId)).toEqual(["second.mine"]);
    expect(conflicts[0]?.conflictingId).toBe("first.mine");
  });

  test("extension commands never dispatch in pager scope", () => {
    const { commands } = buildExtensionAppCommands({
      registered: [registeredCommand("meta", "toggle", "y")],
      builtins: builtinCommandMatchProbes(),
      runCommand: () => {},
    });

    expect(dispatchAppCommand(commands, "pager", chordEvent("y"))).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import type { RegisteredCommand } from "../../extensions/types";
import { synthesizeKeyEvent, parseKeyChord } from "../../lib/commandKeys";
import { builtinCommandMatchProbes, dispatchAppCommand } from "./appCommands";
import { buildExtensionAppCommands } from "./extensionCommands";

function registeredCommand(
  extensionId: string,
  id: string,
  key?: string | readonly string[],
): RegisteredCommand {
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
    // Both are listed for the Extensions menu; only the bound one has a key.
    expect(commands.map((command) => command.id)).toEqual(["meta.toggle", "meta.silent"]);
    expect(commands.map((command) => command.keyLabels)).toEqual([["y"], []]);
    expect(dispatchAppCommand(commands, chordEvent("y"))?.id).toBe("meta.toggle");
    expect(ran).toEqual(["meta.toggle"]);
  });

  test("refuses chords owned by built-in shortcuts", () => {
    const { commands, conflicts } = buildExtensionAppCommands({
      // "s" toggles the sidebar and "[" is hunk navigation; both are taken.
      registered: [registeredCommand("meta", "steal-s", "s"), registeredCommand("meta", "ok", "y")],
      builtins: builtinCommandMatchProbes(),
      runCommand: () => {},
    });

    // The refused command stays in the table, just without the key it wanted.
    expect(commands.map((command) => command.id)).toEqual(["meta.steal-s", "meta.ok"]);
    expect(commands.map((command) => command.keyLabels)).toEqual([[], ["y"]]);
    expect(conflicts).toEqual([
      {
        extensionId: "meta",
        fullId: "meta.steal-s",
        key: "s",
        conflictingId: "hunk.view.toggleSidebar",
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

    expect(commands.map((command) => command.id)).toEqual(["first.mine", "second.mine"]);
    expect(commands.map((command) => command.keyLabels)).toEqual([["y"], []]);
    expect(conflicts.map((conflict) => conflict.fullId)).toEqual(["second.mine"]);
    expect(conflicts[0]?.conflictingId).toBe("first.mine");
  });

  test("binds one command to every chord it declares", () => {
    const ran: string[] = [];
    const { commands, conflicts } = buildExtensionAppCommands({
      registered: [registeredCommand("meta", "toggle", ["y", "ctrl+o"])],
      builtins: builtinCommandMatchProbes(),
      runCommand: (registered) => ran.push(`${registered.extensionId}.${registered.command.id}`),
    });

    expect(conflicts).toEqual([]);
    // One command, one dispatch entry, matching either chord.
    expect(commands).toHaveLength(1);
    expect(commands[0]?.keyLabels).toEqual(["y", "Ctrl+O"]);
    expect(dispatchAppCommand(commands, chordEvent("y"))?.id).toBe("meta.toggle");
    expect(dispatchAppCommand(commands, chordEvent("ctrl+o"))?.id).toBe("meta.toggle");
    expect(ran).toEqual(["meta.toggle", "meta.toggle"]);
  });

  test("drops only the conflicting chord of a multi-key command", () => {
    const { commands, conflicts } = buildExtensionAppCommands({
      // "s" toggles the sidebar; "y" is free.
      registered: [registeredCommand("meta", "toggle", ["s", "y"])],
      builtins: builtinCommandMatchProbes(),
      runCommand: () => {},
    });

    expect(conflicts).toEqual([
      {
        extensionId: "meta",
        fullId: "meta.toggle",
        key: "s",
        conflictingId: "hunk.view.toggleSidebar",
      },
    ]);
    // The command stays registered and keeps the chord nobody else owns.
    expect(commands.map((command) => command.id)).toEqual(["meta.toggle"]);
    expect(dispatchAppCommand(commands, chordEvent("y"))?.id).toBe("meta.toggle");
  });

  test("a user keybinding replaces the chords an extension declared", () => {
    const resolvedKeys = new Map<string, readonly string[]>([["meta.toggle", ["ctrl+j"]]]);
    const { commands } = buildExtensionAppCommands({
      registered: [registeredCommand("meta", "toggle", "y")],
      builtins: builtinCommandMatchProbes(),
      resolvedKeys,
      runCommand: () => {},
    });

    expect(dispatchAppCommand(commands, chordEvent("ctrl+j"))?.id).toBe("meta.toggle");
    expect(dispatchAppCommand(commands, chordEvent("y"))).toBeUndefined();
  });

  test("a chord a built-in released is free for an extension to claim", () => {
    // The user moved the sidebar toggle to "ctrl+b", so "s" belongs to nobody.
    const resolvedKeys = new Map<string, readonly string[]>([
      ["hunk.view.toggleSidebar", ["ctrl+b"]],
    ]);
    const { commands, conflicts } = buildExtensionAppCommands({
      registered: [registeredCommand("meta", "steal-s", "s")],
      builtins: builtinCommandMatchProbes(resolvedKeys),
      runCommand: () => {},
    });

    expect(conflicts).toEqual([]);
    expect(dispatchAppCommand(commands, chordEvent("s"))?.id).toBe("meta.steal-s");
  });
});

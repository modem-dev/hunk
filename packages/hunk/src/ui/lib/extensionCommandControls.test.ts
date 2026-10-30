import { describe, expect, test } from "bun:test";
import type { AppCommand } from "./appCommands";
import { MAX_APP_COMMAND_COUNT } from "./appCommands";
import { createExtensionCommandControls } from "./extensionCommandControls";

/** Build one host command without coupling these capability tests to App callbacks. */
function testCommand({
  id = "hunk.review.nextHunk",
  aliases,
  enabled = true,
  publicToExtensions = true,
  run = () => {},
}: {
  id?: string;
  aliases?: readonly string[];
  enabled?: boolean;
  publicToExtensions?: boolean;
  run?: AppCommand["run"];
} = {}): AppCommand {
  return {
    id,
    aliases,
    title: id,
    keys: [],
    keyLabels: [],
    defaultKeys: [],
    publicToExtensions,
    isEnabled: () => enabled,
    match: () => false,
    run,
  };
}

describe("extension command controls", () => {
  test("executes an enabled public Hunk command with one normalized count", () => {
    const counts: number[] = [];
    const command = testCommand({ run: (_key, count) => counts.push(count) });
    const controls = createExtensionCommandControls({
      getCommands: () => [command],
      isLive: () => true,
    });

    expect(controls.isEnabled(command.id)).toBe(true);
    expect(controls.execute(command.id, { count: 7 })).toBe(true);
    expect(controls.execute(command.id, { count: MAX_APP_COMMAND_COUNT })).toBe(true);
    expect(counts).toEqual([7, MAX_APP_COMMAND_COUNT]);
  });

  test("accepts a public compatibility alias without duplicating the command", () => {
    const counts: number[] = [];
    const command = testCommand({
      id: "hunk.view.toggleFilesPane",
      aliases: ["hunk.view.toggleSidebar"],
      run: (_key, count) => counts.push(count),
    });
    const controls = createExtensionCommandControls({
      getCommands: () => [command],
      isLive: () => true,
    });

    expect(controls.isEnabled("hunk.view.toggleSidebar")).toBe(true);
    expect(controls.execute("hunk.view.toggleSidebar", { count: 2 })).toBe(true);
    expect(counts).toEqual([2]);
  });

  test("resolves the live table on every call", () => {
    let commands: readonly AppCommand[] = [testCommand({ enabled: false })];
    const controls = createExtensionCommandControls({
      getCommands: () => commands,
      isLive: () => true,
    });

    expect(controls.isEnabled("hunk.review.nextHunk")).toBe(false);
    commands = [testCommand()];
    expect(controls.isEnabled("hunk.review.nextHunk")).toBe(true);
  });

  test("refuses unknown, disabled, private, extension-owned, and stale commands", () => {
    let live = true;
    const enabled = testCommand();
    const commands = [
      enabled,
      testCommand({ id: "hunk.app.refresh", enabled: false }),
      testCommand({ id: "hunk.internal.probe", publicToExtensions: false }),
      testCommand({ id: "example.run" }),
    ];
    const controls = createExtensionCommandControls({
      getCommands: () => commands,
      isLive: () => live,
    });

    expect(controls.isEnabled("hunk.missing")).toBe(false);
    expect(controls.execute("hunk.missing")).toBe(false);
    expect(controls.isEnabled("hunk.app.refresh")).toBe(false);
    expect(controls.execute("hunk.app.refresh")).toBe(false);
    expect(controls.isEnabled("hunk.internal.probe")).toBe(false);
    expect(controls.execute("hunk.internal.probe")).toBe(false);
    expect(controls.isEnabled("example.run")).toBe(false);
    expect(controls.execute("example.run")).toBe(false);
    live = false;
    expect(controls.isEnabled(enabled.id)).toBe(false);
    expect(controls.execute(enabled.id)).toBe(false);
  });

  test("keeps probes non-throwing while execution rejects malformed input even when stale", () => {
    const controls = createExtensionCommandControls({
      getCommands: () => [testCommand()],
      isLive: () => true,
    });

    expect(controls.isEnabled("" as never)).toBe(false);
    expect(controls.isEnabled(null as never)).toBe(false);
    expect(controls.isEnabled(42 as never)).toBe(false);
    expect(() => controls.execute("")).toThrow("non-empty command id");
    expect(() => controls.execute("hunk.review.nextHunk", null as never)).toThrow(
      "options must be an object",
    );
    expect(() => controls.execute("hunk.unknown", null as never)).toThrow(
      "options must be an object",
    );
    for (const count of [0, -1, 1.5, Number.NaN, MAX_APP_COMMAND_COUNT + 1]) {
      expect(() => controls.execute("hunk.review.nextHunk", { count })).toThrow(
        `no greater than ${MAX_APP_COMMAND_COUNT}`,
      );
    }

    const staleControls = createExtensionCommandControls({
      getCommands: () => [testCommand()],
      isLive: () => false,
    });
    expect(() => staleControls.execute("hunk.review.nextHunk", { count: 0 })).toThrow(
      `no greater than ${MAX_APP_COMMAND_COUNT}`,
    );
  });
});

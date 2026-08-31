import { describe, expect, test } from "bun:test";
import { getBundledUIRegistry } from ".";
import { paneKey } from "../../apply";
import { BUNDLED_EDITOR_COMMAND_FULL_ID } from "./editor";

describe("bundled UI registry", () => {
  test("registers the built-in files pane and editor command", () => {
    const registry = getBundledUIRegistry();
    const panes = registry.panes;
    expect(panes.map(paneKey)).toEqual(["hunk:files"]);
    expect(
      registry.commands.map(({ extensionId, command }) => `${extensionId}.${command.id}`),
    ).toEqual([BUNDLED_EDITOR_COMMAND_FULL_ID]);
    expect(registry.extensions).toHaveLength(1);
    expect(registry.extensions[0]?.origin).toBe("bundled");
  });
});

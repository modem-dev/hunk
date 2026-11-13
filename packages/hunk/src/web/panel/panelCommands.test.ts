import { describe, expect, test } from "bun:test";
import { APP_COMMAND_CATALOG } from "../../core/run/commandCatalog";
import { bindWebCommands, defaultWebKeymap } from "../commands/keyboard";
import { WEB_LOCAL_COMMANDS } from "../commands/webLocalCommands";
import { webLocalKeyCommands, withWebLocalChords } from "./panelCommands";

describe("page commands with plain chords", () => {
  test("live under hunk.web.*, outside the catalog, on chords no catalog command uses", () => {
    const catalogIds = new Set(APP_COMMAND_CATALOG.map((entry) => entry.id));
    const catalogChords = new Set(APP_COMMAND_CATALOG.flatMap((entry) => entry.defaultKeys));
    for (const command of WEB_LOCAL_COMMANDS) {
      expect(command.id.startsWith("hunk.web.")).toBe(true);
      expect(catalogIds.has(command.id)).toBe(false);
      for (const chord of "keys" in command ? command.keys : []) {
        expect([command.id, catalogChords.has(chord)]).toEqual([command.id, false]);
      }
    }
  });

  test("bind through the page's keymap and run by id", () => {
    const ran: string[] = [];
    const commands = webLocalKeyCommands((id) => ran.push(id));
    const bindings = bindWebCommands(commands, withWebLocalChords(defaultWebKeymap()));
    bindings.match({ name: "p", sequence: "p" })?.run({ count: 1, shift: false });
    bindings.match({ name: "o", sequence: "O", shift: true })?.run({ count: 1, shift: true });
    bindings.match({ name: "n", sequence: "N", shift: true })?.run({ count: 1, shift: true });

    expect(ran).toEqual([
      "hunk.web.toggleSidePanel",
      "hunk.web.showOverview",
      "hunk.web.showNotes",
    ]);
  });

  // Intent: the user's binding wins over a page default on the same key, so the key keeps
  // doing what the user bound and no hint names it for the page command.
  test("give up a default chord the user bound to another command", () => {
    const keymap = withWebLocalChords(
      new Map([
        ["hunk.review.nextHunk", ["p"]],
        ["hunk.review.prevHunk", ["shift+v"]],
      ]),
    );

    expect(keymap.get("hunk.web.toggleSidePanel")).toEqual([]);
    expect(keymap.get("hunk.web.toggleViewed")).toEqual([]);
    expect(keymap.get("hunk.web.showOverview")).toEqual(["O"]);
    const ran: string[] = [];
    const bindings = bindWebCommands(
      webLocalKeyCommands((id) => ran.push(id)),
      keymap,
    );
    expect(bindings.match({ name: "p", sequence: "p" })).toBeUndefined();
  });

  test("leave a chord the host resolved for the same id in place", () => {
    const keymap = withWebLocalChords(new Map([["hunk.web.toggleSidePanel", ["x"]]]));

    expect(keymap.get("hunk.web.toggleSidePanel")).toEqual(["x"]);
    expect(keymap.get("hunk.web.showOverview")).toEqual(["O"]);
  });
});

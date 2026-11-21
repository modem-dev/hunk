import { describe, expect, test } from "bun:test";
import { HELP_SECTIONS } from "../../core/run/helpSections";
import { APP_COMMAND_CATALOG } from "../../core/run/commandCatalog";
import { defaultWebKeymap, webCommandChords } from "../commands/keyboard";
import {
  WEB_COMMAND_SUPPORT,
  buildWebCommands,
  isWebImplementedCommand,
  type WebCommandHandlers,
} from "../commands/webCommandTable";
import { WEB_LOCAL_COMMANDS, matchWebLocalChord } from "../commands/webLocalCommands";
import {
  buildPaletteEntries,
  buildWebHelpSections,
  rankPaletteEntries,
  rememberRecentCommand,
  webLocalHelpRows,
} from "./paletteEntries";

/** The page's commands with handlers that do nothing. */
function createTestCommands() {
  const handlers = new Proxy({} as WebCommandHandlers, { get: () => () => undefined });
  return buildWebCommands(handlers);
}

describe("command palette parity", () => {
  test("lists exactly the implemented catalog commands and the page's own", () => {
    const ids = buildPaletteEntries(createTestCommands(), defaultWebKeymap()).map(
      (entry) => entry.id,
    );
    const implemented = APP_COMMAND_CATALOG.map((entry) => entry.id).filter(
      isWebImplementedCommand,
    );
    expect(ids).toEqual([...implemented, ...WEB_LOCAL_COMMANDS.map((command) => command.id)]);
    for (const entry of APP_COMMAND_CATALOG) {
      if (
        WEB_COMMAND_SUPPORT[entry.id as keyof typeof WEB_COMMAND_SUPPORT].kind === "unavailable"
      ) {
        expect(ids).not.toContain(entry.id);
      }
    }
  });

  test("keeps page-only commands under hunk.web.* and out of the catalog", () => {
    const catalogIds = new Set(APP_COMMAND_CATALOG.map((entry) => entry.id as string));
    for (const command of WEB_LOCAL_COMMANDS) {
      expect(command.id.startsWith("hunk.web.")).toBe(true);
      expect(catalogIds.has(command.id)).toBe(false);
    }
  });

  test("shows the chord the page binds, in the platform's spelling", () => {
    const entries = buildPaletteEntries(createTestCommands(), defaultWebKeymap(), false);
    expect(entries.find((entry) => entry.id === "hunk.review.nextHunk")?.keys).toBe("]");
    expect(entries.find((entry) => entry.id === "hunk.web.commandPalette")?.keys).toBe("Ctrl+K");
    const apple = buildPaletteEntries(createTestCommands(), defaultWebKeymap(), true);
    expect(apple.find((entry) => entry.id === "hunk.web.goToFile")?.keys).toBe("⌘P");
  });

  // Intent: a page default the user's binding took over is not named in the palette or help,
  // so no hint promises a key that does something else.
  test("names a page chord only while the user has not bound it elsewhere", () => {
    const keymap = new Map(defaultWebKeymap());
    expect(
      buildPaletteEntries(createTestCommands(), keymap).find(
        (entry) => entry.id === "hunk.web.toggleSidePanel",
      )?.keys,
    ).toBe("p");
    keymap.set("hunk.review.nextHunk", ["p"]);

    const entries = buildPaletteEntries(createTestCommands(), keymap);
    expect(entries.find((entry) => entry.id === "hunk.web.toggleSidePanel")?.keys).toBeUndefined();
    expect(entries.find((entry) => entry.id === "hunk.web.showOverview")?.keys).toBe("O");
    expect(webLocalHelpRows(keymap).map((row) => row.description)).not.toContain(
      "toggle the side panel",
    );
  });
});

describe("palette ranking", () => {
  const entries = buildPaletteEntries(createTestCommands(), defaultWebKeymap());

  test("puts recent commands first when nothing is typed", () => {
    const recents = rememberRecentCommand(
      rememberRecentCommand([], "hunk.view.layoutSplit"),
      "hunk.web.goToFile",
    );
    expect(
      rankPaletteEntries(entries, "", recents)
        .slice(0, 2)
        .map((entry) => entry.id),
    ).toEqual(["hunk.web.goToFile", "hunk.view.layoutSplit"]);
  });

  test("matches titles fuzzily", () => {
    const ranked = rankPaletteEntries(entries, "nxt hnk", []);
    expect(ranked[0]?.id).toBe("hunk.review.nextHunk");
    expect(rankPaletteEntries(entries, "zzzz", [])).toEqual([]);
  });
});

describe("help overlay parity", () => {
  test("groups like the terminal's help and keys only commands the page binds", () => {
    const keymap = defaultWebKeymap();
    const sections = buildWebHelpSections(keymap);
    const sharedTitles = HELP_SECTIONS.map((section) => section.title);
    expect(sections.map((section) => section.title)).toEqual(
      sharedTitles.filter((title) => sections.some((section) => section.title === title)),
    );
    const documented = HELP_SECTIONS.flatMap((section) =>
      section.entries.flatMap((entry) => ("commandIds" in entry ? [...entry.commandIds] : [])),
    );
    const shownDescriptions = new Set(
      sections.flatMap((section) => section.rows).map((row) => row.description),
    );
    for (const section of HELP_SECTIONS) {
      for (const entry of section.entries) {
        const works =
          !entry.terminalOnly &&
          ("keys" in entry ||
            entry.commandIds.some(
              (id) => isWebImplementedCommand(id) && webCommandChords(keymap, id).length > 0,
            ));
        expect({ row: entry.description, shown: shownDescriptions.has(entry.description) }).toEqual(
          {
            row: entry.description,
            shown: works,
          },
        );
      }
    }
    expect(documented).toContain("hunk.app.quit");
    expect(shownDescriptions.has("quit")).toBe(false);
  });

  test("adds the page's own chords under Browser", () => {
    const sections = buildWebHelpSections(defaultWebKeymap(), [
      { keys: "Ctrl+K", description: "command palette" },
    ]);
    expect(sections.at(-1)).toEqual({
      title: "Browser",
      rows: [{ keys: "Ctrl+K", description: "command palette" }],
    });
  });
});

describe("page chords", () => {
  test("claims Ctrl/Cmd+K and Ctrl/Cmd+P and nothing else", () => {
    const key = (
      k: string,
      modifiers: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>>,
    ) => ({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...modifiers,
    });
    expect(matchWebLocalChord(key("k", { ctrlKey: true }))).toBe("hunk.web.commandPalette");
    expect(matchWebLocalChord(key("p", { metaKey: true }))).toBe("hunk.web.goToFile");
    expect(matchWebLocalChord(key("k", {}))).toBeUndefined();
    expect(matchWebLocalChord(key("k", { ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(matchWebLocalChord(key("d", { ctrlKey: true }))).toBeUndefined();
  });
});

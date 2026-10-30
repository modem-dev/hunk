import { expect, mock, test } from "bun:test";
import type { DocumentSource } from "../../core/documents/source";
import { resolveCommandKeys } from "../lib/keymap";
import { executeAppCommand } from "../lib/appCommands";
import { DOCUMENT_COMMAND_CATALOG } from "../../core/run/documentCommandCatalog";
import { DocumentBrowserController } from "./controller";
import { buildDocumentCommands, buildDocumentMenus } from "./commands";

/** Create document commands backed by a real browser controller with opaque source keys. */
async function createTestDocumentCommands(treeFocused: boolean) {
  const source: DocumentSource = {
    root: { key: "root", name: "root", kind: "directory", hidden: false },
    async list(key) {
      if (key !== "root") return { kind: "entries", entries: [] };
      return {
        kind: "entries",
        entries: [
          { key: "nested", name: "nested", kind: "directory", hidden: false },
          { key: "file", name: "file", kind: "file", hidden: false },
        ],
      };
    },
    async read() {
      return { kind: "text", text: "complete", identity: "stable" };
    },
  };
  const controller = new DocumentBrowserController(source);
  await controller.initialize();
  const scrollBy = mock((_delta: unknown) => undefined);
  const scrollTo = mock((_position: unknown) => undefined);
  const edit = mock(() => undefined);
  const keys = resolveCommandKeys({
    defaults: DOCUMENT_COMMAND_CATALOG,
    userBindings: { "hunk.documents.stepDown": "n" },
  });
  const commands = buildDocumentCommands({
    controller,
    isTreeFocused: () => treeFocused,
    height: 12,
    scrollRef: { current: { scrollBy, scrollTo, scrollHeight: 100 } },
    edit,
    resolvedKeys: keys.keys,
    actions: {
      "hunk.app.quit": () => {},
      "hunk.app.refresh": () => {},
      "hunk.app.toggleFocusArea": () => {},
      "hunk.app.toggleHelp": () => {},
      "hunk.view.openThemeSelector": () => {},
      "hunk.view.toggleFilesPane": () => {},
      "hunk.view.toggleLineNumbers": () => {},
      "hunk.view.toggleLineWrap": () => {},
    },
  });
  return { controller, commands, scrollBy, scrollTo, edit };
}

test("document commands scroll by physical rows and keep tree selection independent", async () => {
  const setup = await createTestDocumentCommands(false);
  try {
    for (const id of ["stepDown", "stepUp", "pageDown", "pageUp", "scrollLeft", "scrollRight"])
      executeAppCommand(setup.commands, `hunk.documents.${id}`);
    expect(setup.scrollBy.mock.calls.map(([delta]) => delta)).toEqual([
      1,
      -1,
      11,
      -11,
      { x: -4, y: 0 },
      { x: 4, y: 0 },
    ]);
    executeAppCommand(setup.commands, "hunk.documents.jumpToTop");
    executeAppCommand(setup.commands, "hunk.documents.jumpToBottom");
    expect(setup.scrollTo.mock.calls.map(([position]) => position)).toEqual([0, 100]);
    expect(setup.controller.getSnapshot().selectedKey).toBe("root");
  } finally {
    await setup.controller.close();
  }
});

test("tree commands use live selection and only toggle directories needing expansion changes", async () => {
  const setup = await createTestDocumentCommands(true);
  try {
    await setup.controller.select("nested");
    executeAppCommand(setup.commands, "hunk.documents.scrollRight");
    expect(setup.controller.getSnapshot().expanded.has("nested")).toBe(true);
    executeAppCommand(setup.commands, "hunk.documents.scrollRight");
    expect(setup.controller.getSnapshot().expanded.has("nested")).toBe(true);
    executeAppCommand(setup.commands, "hunk.documents.scrollLeft");
    expect(setup.controller.getSnapshot().expanded.has("nested")).toBe(false);
    await setup.controller.select("file");
    executeAppCommand(setup.commands, "hunk.documents.scrollRight");
    expect(setup.controller.getSnapshot().expanded.has("file")).toBe(false);
    executeAppCommand(setup.commands, "hunk.documents.jumpToTop");
    expect(setup.controller.getSnapshot().selectedKey).toBe("root");
    executeAppCommand(setup.commands, "hunk.documents.jumpToBottom");
    expect(setup.controller.getSnapshot().selectedKey).toBe("file");
    expect(setup.scrollBy).not.toHaveBeenCalled();
  } finally {
    await setup.controller.close();
  }
});

test("document menus share effective key labels and command handlers", async () => {
  const setup = await createTestDocumentCommands(false);
  try {
    const menus = buildDocumentMenus(setup.commands, {
      sidebar: true,
      numbers: false,
      wrap: true,
      showExcluded: true,
    });
    const edit = menus.file.find(
      (entry) => entry.kind === "item" && entry.commandId === "hunk.documents.edit",
    );
    if (edit?.kind !== "item") throw new Error("Missing editor menu action.");
    edit.action();
    expect(setup.edit).toHaveBeenCalledTimes(1);
    const numbers = menus.view.find(
      (entry) => entry.kind === "item" && entry.commandId === "hunk.view.toggleLineNumbers",
    );
    expect(numbers).toMatchObject({ checked: false });
    expect(
      setup.commands.find((command) => command.id === "hunk.documents.stepDown")?.keyLabels,
    ).toEqual(["n"]);
  } finally {
    await setup.controller.close();
  }
});

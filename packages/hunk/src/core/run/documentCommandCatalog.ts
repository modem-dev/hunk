import { builtinAppCommand, type AppCommandId } from "./commandCatalog";

export interface DocumentCommandCatalogEntry {
  id: string;
  title: string;
  defaultKeys: readonly string[];
  aliases?: readonly string[];
  publicToExtensions: false;
}

/** Reuse app/view command identities and defaults without granting review-extension authority. */
function sharedDocumentCommand<const Id extends AppCommandId>(id: Id, title?: string) {
  const shared = builtinAppCommand(id);
  return {
    id,
    title: title ?? shared.title,
    defaultKeys: shared.defaultKeys,
    aliases: shared.aliases,
    publicToExtensions: false as const,
  };
}

/** Declare document actions independently of review hunks, selection and remote capabilities. */
export const DOCUMENT_COMMAND_CATALOG = [
  sharedDocumentCommand("hunk.app.quit"),
  sharedDocumentCommand("hunk.app.refresh", "Refresh documents"),
  sharedDocumentCommand("hunk.app.toggleFocusArea", "Switch tree / document focus"),
  sharedDocumentCommand("hunk.app.toggleHelp", "Controls help"),
  sharedDocumentCommand("hunk.view.openThemeSelector"),
  sharedDocumentCommand("hunk.view.toggleFilesPane", "Directory tree"),
  sharedDocumentCommand("hunk.view.toggleLineNumbers", "Line numbers"),
  sharedDocumentCommand("hunk.view.toggleLineWrap", "Wrap lines"),
  {
    id: "hunk.documents.toggleExcluded",
    title: "Hidden and ignored entries",
    defaultKeys: ["i"],
    publicToExtensions: false,
  },
  {
    id: "hunk.documents.activate",
    title: "Open / expand selected entry",
    defaultKeys: ["enter", "space"],
    publicToExtensions: false,
  },
  {
    id: "hunk.documents.edit",
    title: "Open file in $EDITOR",
    defaultKeys: ["e"],
    publicToExtensions: false,
  },
  {
    id: "hunk.documents.stepDown",
    title: "Next row",
    defaultKeys: ["down", "j"],
    publicToExtensions: false,
  },
  {
    id: "hunk.documents.stepUp",
    title: "Previous row",
    defaultKeys: ["up", "k"],
    publicToExtensions: false,
  },
  {
    id: "hunk.documents.pageDown",
    title: "Page down",
    defaultKeys: ["pagedown", "f"],
    publicToExtensions: false,
  },
  {
    id: "hunk.documents.pageUp",
    title: "Page up",
    defaultKeys: ["pageup", "b"],
    publicToExtensions: false,
  },
  {
    id: "hunk.documents.jumpToTop",
    title: "Jump to start",
    defaultKeys: ["g", "home"],
    publicToExtensions: false,
  },
  {
    id: "hunk.documents.jumpToBottom",
    title: "Jump to end",
    defaultKeys: ["G", "end"],
    publicToExtensions: false,
  },
  {
    id: "hunk.documents.scrollLeft",
    title: "Scroll left / collapse",
    defaultKeys: ["left"],
    publicToExtensions: false,
  },
  {
    id: "hunk.documents.scrollRight",
    title: "Scroll right / expand",
    defaultKeys: ["right"],
    publicToExtensions: false,
  },
] as const satisfies readonly DocumentCommandCatalogEntry[];

/** Recognize document bindings on other surfaces without making those actions executable there. */
export const DOCUMENT_COMMAND_NAMES: ReadonlySet<string> = new Set(
  DOCUMENT_COMMAND_CATALOG.map((entry) => entry.id),
);

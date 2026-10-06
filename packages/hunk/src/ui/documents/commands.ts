import type { ScrollBoxRenderable } from "@opentui/core";
import { DOCUMENT_COMMAND_CATALOG } from "../../core/run/documentCommandCatalog";
import type { AppMenus, MenuEntry } from "../components/chrome/menu";
import type { AppCommand, ResolvedCommandKeys } from "../lib/appCommands";
import { executeAppCommand } from "../lib/appCommands";
import { buildSurfaceCommands } from "../session/commands";
import type { DocumentBrowserController } from "./controller";

type DocumentCommandId = (typeof DOCUMENT_COMMAND_CATALOG)[number]["id"];
type DocumentChromeCommandId = Exclude<DocumentCommandId, `hunk.documents.${string}`>;
type DocumentScrollRef = {
  current: Pick<ScrollBoxRenderable, "scrollBy" | "scrollTo" | "scrollHeight"> | null;
};

/** Bind document navigation to the current focus and snapshot without branching on command ids. */
export function buildDocumentCommands({
  controller,
  treeFocused,
  height,
  scrollRef,
  edit,
  actions,
  resolvedKeys,
}: {
  controller: DocumentBrowserController;
  treeFocused: boolean;
  height: number;
  scrollRef: DocumentScrollRef;
  edit: () => void;
  actions: Record<DocumentChromeCommandId, () => void>;
  resolvedKeys: ResolvedCommandKeys;
}): AppCommand[] {
  /** Read the live selected entry rather than retaining a selection from the render. */
  const selectedEntry = () => {
    const current = controller.getSnapshot();
    return current.rows.find((row) => row.entry.key === current.selectedKey)?.entry;
  };
  /** Move through the focused tree or document by physical rows. */
  const step = (delta: number) => {
    if (treeFocused) controller.move(delta);
    else scrollRef.current?.scrollBy(delta);
  };
  /** Reveal the beginning or end of the focused surface. */
  const jump = (end: boolean) => {
    if (treeFocused) controller.move(controller.getSnapshot().rows.length * (end ? 1 : -1));
    else scrollRef.current?.scrollTo(end ? scrollRef.current.scrollHeight : 0);
  };
  /** Expand/collapse a selected directory or scroll the document horizontally. */
  const horizontal = (expand: boolean) => {
    const selected = selectedEntry();
    if (!treeFocused) {
      scrollRef.current?.scrollBy({ x: expand ? 4 : -4, y: 0 });
      return;
    }
    if (
      selected?.kind === "directory" &&
      controller.getSnapshot().expanded.has(selected.key) !== expand
    )
      void controller.activate(selected.key);
  };
  const handlers: Record<DocumentCommandId, () => void> = {
    ...actions,
    "hunk.documents.toggleExcluded": () => controller.toggleExcluded(),
    "hunk.documents.activate": () => {
      const selected = selectedEntry();
      if (selected) void controller.activate(selected.key);
    },
    "hunk.documents.edit": edit,
    "hunk.documents.stepDown": () => step(1),
    "hunk.documents.stepUp": () => step(-1),
    "hunk.documents.pageDown": () => step(height - 1),
    "hunk.documents.pageUp": () => step(1 - height),
    "hunk.documents.jumpToTop": () => jump(false),
    "hunk.documents.jumpToBottom": () => jump(true),
    "hunk.documents.scrollLeft": () => horizontal(false),
    "hunk.documents.scrollRight": () => horizontal(true),
  };
  return buildSurfaceCommands(DOCUMENT_COMMAND_CATALOG, {
    resolvedKeys,
    run: (entry) => handlers[entry.id](),
  });
}

/** Build menu actions from the same effective commands used by the keyboard. */
export function buildDocumentMenus(
  commands: readonly AppCommand[],
  state: {
    sidebar: boolean;
    numbers: boolean;
    wrap: boolean;
    showExcluded: boolean;
  },
): Required<Pick<AppMenus, "file" | "view" | "help">> {
  const item = (id: DocumentCommandId, checked?: boolean): MenuEntry => {
    const command = commands.find((command) => command.id === id)!;
    return {
      kind: "item",
      label: command.title,
      commandId: id,
      hint: command.keyLabels.join(" / "),
      checked,
      action: () => {
        executeAppCommand(commands, id);
      },
    };
  };
  return {
    file: [item("hunk.app.refresh"), item("hunk.documents.edit"), item("hunk.app.quit")],
    view: [
      item("hunk.view.openThemeSelector"),
      item("hunk.view.toggleFilesPane", state.sidebar),
      item("hunk.view.toggleLineNumbers", state.numbers),
      item("hunk.view.toggleLineWrap", state.wrap),
      item("hunk.documents.toggleExcluded", state.showExcluded),
    ],
    help: [item("hunk.app.toggleHelp")],
  };
}

import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { CommonOptions } from "../../core/run/commandInputs";
import type { UserKeyBinding } from "../../core/run/config";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { MenuBar } from "../components/chrome/MenuBar";
import { MenuDropdown } from "../components/chrome/MenuDropdown";
import { HelpDialog } from "../components/chrome/HelpDialog";
import { ThemeSelectorDialog } from "../components/chrome/ThemeSelectorDialog";
import { useMenuController } from "../hooks/useMenuController";
import { useThemeSelectorController } from "../hooks/useThemeSelectorController";
import { useTimedNotice } from "../hooks/useTimedNotice";
import { APP_COMMAND_NAMES } from "../../core/run/commandCatalog";
import { HISTORY_COMMAND_NAMES } from "../../core/run/historyCommandCatalog";
import { DOCUMENT_COMMAND_CATALOG } from "../../core/run/documentCommandCatalog";
import { resolveCommandKeys } from "../lib/keymap";
import { openFileInEditor } from "../lib/openInEditor";
import type { ThemeController } from "../theme/controller";
import { DocumentContent, DocumentStatusBar } from "./DocumentContent";
import { buildDocumentCommands, buildDocumentMenus } from "./commands";
import { useDocumentKeyboard } from "./useDocumentKeyboard";
import { useDocumentInteractionState } from "./useDocumentInteractionState";
import type { DocumentBrowserController } from "./controller";

/** Coordinate document navigation, editor launches and shared chrome without owning source I/O.
 * Keep tree selection independent from the displayed document and preserve the mounted scroll refs.
 */
export function DocumentApp({
  controller,
  themeController,
  options,
  keybindings,
  onQuit,
}: {
  controller: DocumentBrowserController;
  themeController: ThemeController;
  options: CommonOptions;
  keybindings: Record<string, UserKeyBinding>;
  onQuit: () => void;
}) {
  const terminal = useTerminalDimensions();
  const renderer = useRenderer();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const interaction = useDocumentInteractionState({
    focus: controller.source.root.kind === "directory" ? "tree" : "document",
    sidebar: options.sidebar !== false && controller.source.root.kind === "directory",
    help: false,
  });
  const { focus, sidebar, help } = interaction.state;

  /** Read focus after all preceding keyboard or pointer actions, even before React renders. */
  const isTreeFocused = () => {
    const current = interaction.getSnapshot();
    return current.sidebar && current.focus === "tree";
  };

  /** Close help from either its keyboard owner or its pointer dismiss action. */
  const closeHelp = () => interaction.update((current) => ({ ...current, help: false }));

  const [numbers, setNumbers] = useState(options.lineNumbers !== false);
  const [wrap, setWrap] = useState(options.wrapLines ?? false);

  const notice = useTimedNotice(4000);

  const setNotice = (text: string | null) => {
    if (text === null) notice.clear();
    else notice.show(text);
  };

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const visibleLineRef = useRef(() => 1);

  const themeSelector = useThemeSelectorController({
    themeController,
    transparentBackground: options.transparentBackground ?? false,
    onTransientNotice: notice.show,
  });
  const theme = themeSelector.activeTheme;

  const treeWidth = sidebar ? Math.min(34, Math.max(12, Math.floor(terminal.width / 3))) : 0;
  const height = Math.max(1, terminal.height - 3);
  const treeFocused = sidebar && focus === "tree";

  const keys = useMemo(
    () =>
      resolveCommandKeys({
        defaults: DOCUMENT_COMMAND_CATALOG,
        userBindings: keybindings,
        inactiveCommandNames: new Set([...APP_COMMAND_NAMES, ...HISTORY_COMMAND_NAMES]),
      }),
    [keybindings],
  );

  /** Delegate selected documents to an external editor without borrowing review file types. */
  const edit = async () => {
    if (renderer.isDestroyed || controller.isClosed) return;

    setNotice(
      await controller.editDisplayedDocument(async (filePath) =>
        openFileInEditor({ filePath, line: visibleLineRef.current(), renderer, wait: true }),
      ),
    );
    await controller.refresh();
  };

  const commands = buildDocumentCommands({
    controller,
    isTreeFocused,
    height,
    scrollRef,
    edit: () => {
      void edit();
    },
    resolvedKeys: keys.keys,
    actions: {
      "hunk.app.quit": onQuit,
      "hunk.app.refresh": () => {
        void controller.refresh();
      },
      "hunk.app.toggleFocusArea": () =>
        interaction.update((current) => ({
          ...current,
          focus: current.focus === "tree" ? "document" : "tree",
        })),
      "hunk.app.toggleHelp": () =>
        interaction.update((current) => ({ ...current, help: !current.help })),
      "hunk.view.openThemeSelector": themeSelector.openThemeSelector,
      "hunk.view.toggleFilesPane": () =>
        interaction.update((current) => ({ ...current, sidebar: !current.sidebar })),
      "hunk.view.toggleLineNumbers": () => setNumbers((value) => !value),
      "hunk.view.toggleLineWrap": () => setWrap((value) => !value),
    },
  });

  const menus = buildDocumentMenus(commands, {
    sidebar,
    numbers,
    wrap,
    showExcluded: snapshot.showExcluded,
  });
  const menu = useMenuController(menus);

  useDocumentKeyboard({
    isHelpOpen: () => interaction.getSnapshot().help,
    closeHelp,
    themeSelector,
    menu,
    commands,
  });
  const overlay = help || themeSelector.themeSelectorOpen || menu.activeMenuId !== null;

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
      <MenuBar
        activeMenuId={menu.activeMenuId}
        menuSpecs={menu.menuSpecs}
        terminalWidth={terminal.width}
        theme={theme}
        topTitle={`Open · ${sanitizeTerminalLine(controller.source.root.name)}`}
        onHoverMenu={(id) => {
          if (menu.getActiveMenuId()) menu.openMenu(id);
        }}
        onToggleMenu={menu.toggleMenu}
      />
      <DocumentContent
        snapshot={snapshot}
        sidebar={sidebar}
        treeWidth={treeWidth}
        terminalWidth={terminal.width}
        treeFocused={treeFocused}
        overlay={overlay}
        pane={{
          height,
          wrap,
          tabWidth: options.tabWidth ?? 4,
          theme,
          lineNumbers: numbers,
          scrollRef,
          visibleLineRef,
        }}
        onFocus={(focus) => {
          // Content clicks transfer keyboard ownership as well as the visible focus indicator.
          menu.closeMenu();
          interaction.update((current) => ({ ...current, focus }));
        }}
        onActivate={(key) => {
          void controller.activate(key);
        }}
      />
      <DocumentStatusBar
        snapshot={snapshot}
        notice={notice.text}
        keymapIssue={keys.issues[0]?.message}
        treeFocused={treeFocused}
        width={terminal.width}
        theme={theme}
      />
      {menu.activeMenuId && menu.activeMenuSpec ? (
        <MenuDropdown
          {...menu}
          activeMenuId={menu.activeMenuId}
          activeMenuSpec={menu.activeMenuSpec}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={theme}
          onHoverItem={menu.setActiveMenuItemIndex}
          onSelectItem={(entry) => {
            entry.action();
            menu.closeMenu();
          }}
        />
      ) : null}
      {themeSelector.themeSelectorOpen ? (
        <ThemeSelectorDialog
          items={themeSelector.themeSelectorItems}
          selectedIndex={themeSelector.themeSelectorSelectedIndex}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={theme}
          onAcceptItem={themeSelector.acceptThemeSelectorItem}
          onClose={themeSelector.closeThemeSelector}
          onPreviewItem={themeSelector.previewThemeSelectorItem}
        />
      ) : null}
      {help ? (
        <HelpDialog
          sections={[
            {
              title: "Documents",
              rows: commands
                .filter((command) => command.keyLabels.length)
                .map((command) => ({
                  keys: command.keyLabels.join(" / "),
                  description: command.title,
                })),
            },
          ]}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={theme}
          onClose={closeHelp}
        />
      ) : null}
    </box>
  );
}
